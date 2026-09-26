// POST { address } -> { nonce, chainId, expiresAt }
// The client embeds the nonce in an EIP-4361 (SIWE) message, signs it, and calls auth-verify.
import { generateSiweNonce, isAddress } from "../_shared/deps.ts";
import { adminClient } from "../_shared/db.ts";
import { chainId, siweAllowedDomains } from "../_shared/env.ts";
import { HttpError, json, readJson, serve, str } from "../_shared/http.ts";

const NONCE_TTL_SECONDS = 10 * 60;

serve(async (req) => {
  const body = await readJson(req);
  const address = str(body, "address", 42);
  if (!isAddress(address, { strict: false })) throw new HttpError(400, "BAD_ADDRESS");

  const nonce = generateSiweNonce();
  const expiresAt = new Date(Date.now() + NONCE_TTL_SECONDS * 1000);
  const { error } = await adminClient().from("auth_nonces").insert({
    nonce,
    wallet: address.toLowerCase(),
    expires_at: expiresAt.toISOString(),
  });
  if (error) throw new HttpError(500, "INTERNAL_ERROR");

  return json({ nonce, chainId: chainId(), expiresAt: expiresAt.toISOString(), domains: siweAllowedDomains() });
});
