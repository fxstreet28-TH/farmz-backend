// POST { message, signature } (EIP-4361 / SIWE) -> Supabase session + player.
// 1. parse + validate the SIWE message (domain, chain, nonce, time window)
// 2. verify the signature (EOA via ecrecover; smart wallets via EIP-1271/6492 on-chain)
// 3. consume the nonce (single use)
// 4. find/create the Supabase auth user for the wallet and mint a session
// 5. bootstrap the player (farm, plots, signup bonus) + daily check-in
import { getAddress, type Hex, isAddressEqual, parseSiweMessage, recoverMessageAddress } from "../_shared/deps.ts";
import { adminClient, anonClient, rpc } from "../_shared/db.ts";
import { chainId, siweAllowedDomains, walletEmailDomain } from "../_shared/env.ts";
import { HttpError, json, readJson, serve, str } from "../_shared/http.ts";
import { publicClient } from "../_shared/chain.ts";
import { NEW_PLAYER } from "../_shared/config.ts";

const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;

serve(async (req) => {
  const body = await readJson(req);
  const message = str(body, "message", 4096);
  const signature = str(body, "signature", 20000) as Hex;

  // ---- 1. validate message fields
  const siwe = parseSiweMessage(message);
  if (!siwe.address || !siwe.nonce || !siwe.domain || !siwe.chainId || siwe.version !== "1") {
    throw new HttpError(400, "BAD_SIWE_MESSAGE");
  }
  if (!siweAllowedDomains().includes(siwe.domain)) throw new HttpError(401, "SIWE_DOMAIN_NOT_ALLOWED", siwe.domain);
  if (siwe.chainId !== chainId()) throw new HttpError(401, "SIWE_WRONG_CHAIN");
  const now = Date.now();
  if (!siwe.issuedAt || Math.abs(now - siwe.issuedAt.getTime()) > MAX_MESSAGE_AGE_MS) {
    throw new HttpError(401, "SIWE_STALE");
  }
  if (siwe.expirationTime && siwe.expirationTime.getTime() < now) throw new HttpError(401, "SIWE_EXPIRED");
  if (siwe.notBefore && siwe.notBefore.getTime() > now) throw new HttpError(401, "SIWE_NOT_YET_VALID");
  const wallet = getAddress(siwe.address);

  // ---- 2. signature
  let valid = false;
  try {
    valid = isAddressEqual(await recoverMessageAddress({ message, signature }), wallet);
  } catch { /* not an EOA signature */ }
  if (!valid) {
    try {
      valid = await publicClient().verifyMessage({ address: wallet, message, signature });
    } catch { /* ignore */ }
  }
  if (!valid) throw new HttpError(401, "BAD_SIGNATURE");

  // ---- 3. consume nonce atomically
  const admin = adminClient();
  const { data: used, error: nErr } = await admin.from("auth_nonces")
    .update({ used_at: new Date().toISOString() })
    .eq("nonce", siwe.nonce).eq("wallet", wallet.toLowerCase())
    .is("used_at", null).gt("expires_at", new Date().toISOString())
    .select("nonce");
  if (nErr) throw new HttpError(500, "INTERNAL_ERROR");
  if (!used || used.length !== 1) throw new HttpError(401, "BAD_NONCE");

  // ---- 4. auth user + session (wallet-only accounts use a synthetic, undeliverable email)
  const email = `${wallet.toLowerCase()}@${walletEmailDomain()}`;
  const { error: cErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { wallet: wallet.toLowerCase() },
    app_metadata: { provider: "siwe", wallet: wallet.toLowerCase() },
  });
  if (cErr && !/already|exists|registered/i.test(cErr.message)) {
    console.error("createUser", cErr);
    throw new HttpError(500, "AUTH_USER_CREATE_FAILED");
  }
  const { data: link, error: lErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (lErr || !link.properties?.hashed_token) {
    console.error("generateLink", lErr);
    throw new HttpError(500, "SESSION_FAILED");
  }
  const { data: otp, error: oErr } = await anonClient().auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "magiclink",
  });
  if (oErr || !otp.session || !otp.user) {
    console.error("verifyOtp", oErr);
    throw new HttpError(500, "SESSION_FAILED");
  }

  // ---- 5. player bootstrap + check-in (login streak mission)
  const checkin = await rpc("econ_bootstrap", {
    p_player: otp.user.id,
    p_wallet: wallet.toLowerCase(),
    p_grid_size: NEW_PLAYER.gridSize,
    p_start_coins: NEW_PLAYER.startCoins,
  });

  return json({
    session: {
      access_token: otp.session.access_token,
      refresh_token: otp.session.refresh_token,
      expires_at: otp.session.expires_at,
      token_type: otp.session.token_type,
    },
    wallet,
    checkin,
  });
});
