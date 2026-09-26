// POST -> { claimId, account, amount, amountWei, nonce, deadline, signature, chainId, contract }
// Frontend then calls FarmZClaim.claim(amountWei, nonce, deadline, signature) from `account`.
//
// Flow:
//  1. authenticate player (session JWT)
//  2. settle the player's open claims: return a still-valid one (idempotent), refund ones that
//     provably expired unused on-chain (deadline passed + nonceUsed == false), confirm used ones
//  3. claim_reserve (atomic in SQL): pending/cooldown/daily-max checks, deduct claimable_farmz
//  4. sign EIP-712 Claim{account, amount, nonce, deadline} with CLAIM_SIGNER_PRIVATE_KEY
//  5. store signature; on signing failure the reservation is refunded
import { type Address, getAddress, type Hex } from "../_shared/deps.ts";
import { claimPolicy } from "../_shared/config.ts";
import { adminClient, type Player, requirePlayer, rpc } from "../_shared/db.ts";
import { chainId, claimContract, signerKey } from "../_shared/env.ts";
import { claimDomain, randomNonce, signClaim } from "../_shared/eip712.ts";
import { isNonceUsed } from "../_shared/chain.ts";
import { HttpError, json, serve } from "../_shared/http.ts";

interface ClaimRow {
  id: string;
  account: string;
  amount: string | number;
  amount_wei: string | number;
  nonce: string | number;
  deadline: number;
  signature: string | null;
  status: string;
  created_at: string;
}

const payload = (
  c: {
    id: string;
    account: string;
    amount: string;
    amountWei: string;
    nonce: string;
    deadline: number;
    signature: string;
  },
) => ({
  claimId: c.id,
  account: getAddress(c.account),
  amount: c.amount,
  amountWei: c.amountWei,
  nonce: c.nonce,
  deadline: c.deadline,
  signature: c.signature,
  chainId: chainId(),
  contract: claimContract(),
});

async function settleOpenClaims(player: Player): Promise<Response | null> {
  const policy = claimPolicy();
  // numeric columns are read as text to keep uint256 precision
  const { data, error } = await adminClient().from("claims")
    .select("id, account, amount::text, amount_wei::text, nonce::text, deadline, signature, status, created_at")
    .eq("player_id", player.id).in("status", ["signed", "submitted"]);
  if (error) throw new HttpError(500, "INTERNAL_ERROR");
  const nowSec = Math.floor(Date.now() / 1000);

  for (const c of (data ?? []) as unknown as ClaimRow[]) {
    if (!c.signature) {
      // reserved but never signed (crashed mid-request) -> signature was never handed out, safe to refund
      if (Date.now() - Date.parse(c.created_at) > policy.unsignedStaleSeconds * 1000) {
        await rpc("claim_fail", { p_claim: c.id, p_reason: "unsigned_stale", p_refund: true });
        continue;
      }
      throw new HttpError(409, "CLAIM_IN_PROGRESS");
    }
    if (c.deadline >= nowSec) {
      // still claimable on-chain: hand back the same signature (idempotent)
      return json({
        pending: true,
        ...payload({
          id: c.id,
          account: c.account,
          amount: String(c.amount),
          amountWei: String(c.amount_wei),
          nonce: String(c.nonce),
          deadline: c.deadline,
          signature: c.signature,
        }),
      });
    }
    if (c.deadline + policy.settleGraceSeconds > nowSec) throw new HttpError(409, "CLAIM_SETTLING");
    let used: boolean;
    try {
      used = await isNonceUsed(getAddress(c.account), BigInt(c.nonce));
    } catch (e) {
      console.error("nonceUsed", e);
      throw new HttpError(503, "CHAIN_UNAVAILABLE");
    }
    if (used) await rpc("claim_set_status", { p_claim: c.id, p_status: "confirmed", p_tx_hash: null });
    else await rpc("claim_fail", { p_claim: c.id, p_reason: "expired_unused", p_refund: true });
  }
  return null;
}

serve(async (req) => {
  const key = signerKey();
  if (!key) throw new HttpError(503, "SIGNER_NOT_CONFIGURED");
  const player = await requirePlayer(req);

  const existing = await settleOpenClaims(player);
  if (existing) return existing;

  const policy = claimPolicy();
  const nonce = randomNonce();
  const deadline = Math.floor(Date.now() / 1000) + policy.signatureTtlSeconds;
  const reserved = await rpc<
    { id: string; account: string; amount: string; amount_wei: string; nonce: string; deadline: number }
  >(
    "claim_reserve",
    {
      p_player: player.id,
      p_nonce: nonce.toString(),
      p_deadline: deadline,
      p_max_amount: policy.maxPerClaim,
      p_min_amount: policy.minPerClaim,
      p_cooldown_seconds: policy.cooldownSeconds,
    },
  );

  let signature: Hex;
  try {
    signature = await signClaim(key, claimDomain(chainId(), claimContract()), {
      account: getAddress(reserved.account) as Address,
      amount: BigInt(reserved.amount_wei),
      nonce: BigInt(reserved.nonce),
      deadline: BigInt(reserved.deadline),
    });
    await rpc("claim_attach_signature", { p_claim: reserved.id, p_signature: signature });
  } catch (e) {
    console.error("sign failed", e);
    await rpc("claim_fail", { p_claim: reserved.id, p_reason: "sign_failed", p_refund: true });
    throw new HttpError(500, "SIGN_FAILED");
  }

  return json(payload({
    id: reserved.id,
    account: reserved.account,
    amount: reserved.amount,
    amountWei: reserved.amount_wei,
    nonce: reserved.nonce,
    deadline: reserved.deadline,
    signature,
  }));
});
