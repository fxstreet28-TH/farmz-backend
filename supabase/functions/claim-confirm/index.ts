// POST { claimId, txHash } — frontend reports the FarmZClaim.claim() tx. The backend verifies it
// on-chain (receipt + Claimed event matching account/amount/nonce) before marking it confirmed.
import { getAddress, type Hex, isAddressEqual, parseEventLogs } from "../_shared/deps.ts";
import { adminClient, requirePlayer, rpc } from "../_shared/db.ts";
import { claimContract } from "../_shared/env.ts";
import { FARMZ_CLAIM_ABI, isNonceUsed, publicClient } from "../_shared/chain.ts";
import { HttpError, json, readJson, serve, str, uuid } from "../_shared/http.ts";

serve(async (req) => {
  const player = await requirePlayer(req);
  const body = await readJson(req);
  const claimId = uuid(body, "claimId");
  const txHash = str(body, "txHash", 66);
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new HttpError(400, "BAD_TX_HASH");

  const { data: c, error } = await adminClient().from("claims")
    .select("id, account, amount_wei::text, nonce::text, status")
    .eq("id", claimId).eq("player_id", player.id).maybeSingle();
  if (error) throw new HttpError(500, "INTERNAL_ERROR");
  if (!c) throw new HttpError(404, "CLAIM_NOT_FOUND");
  const claim = c as unknown as { id: string; account: string; amount_wei: string; nonce: string; status: string };
  if (claim.status === "confirmed" || claim.status === "failed") return json({ status: claim.status });

  const client = publicClient();
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
  } catch {
    receipt = null; // not mined yet / unknown
  }

  if (!receipt) {
    return json(await rpc("claim_set_status", { p_claim: claim.id, p_status: "submitted", p_tx_hash: txHash }));
  }
  if (receipt.status !== "success" || !receipt.to || !isAddressEqual(receipt.to, claimContract())) {
    throw new HttpError(409, "TX_NOT_A_SUCCESSFUL_CLAIM");
  }
  const match = parseEventLogs({ abi: FARMZ_CLAIM_ABI, eventName: "Claimed", logs: receipt.logs }).some((l) =>
    isAddressEqual(l.address, claimContract()) &&
    isAddressEqual(l.args.account, getAddress(claim.account)) &&
    l.args.nonce === BigInt(claim.nonce) &&
    l.args.amount === BigInt(claim.amount_wei)
  );
  if (!match && !(await isNonceUsed(getAddress(claim.account), BigInt(claim.nonce)))) {
    throw new HttpError(409, "TX_DOES_NOT_MATCH_CLAIM");
  }
  return json(await rpc("claim_set_status", { p_claim: claim.id, p_status: "confirmed", p_tx_hash: txHash }));
});
