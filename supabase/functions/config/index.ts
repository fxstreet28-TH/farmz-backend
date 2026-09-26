// GET -> public game config (for UI) + claim contract/signer info. No auth needed.
import { ANIMALS, claimPolicy, CROPS, ORDERS, SELL_PRICES, SHOP_ITEMS } from "../_shared/config.ts";
import { chainId, claimContract, signerKey, tokenContract } from "../_shared/env.ts";
import { signerAddress } from "../_shared/eip712.ts";
import { json, serve } from "../_shared/http.ts";

serve(async () => {
  const key = signerKey();
  const p = claimPolicy();
  return json({
    crops: CROPS,
    animals: ANIMALS,
    shop: SHOP_ITEMS,
    sellPrices: SELL_PRICES,
    orders: ORDERS,
    claim: {
      chainId: chainId(),
      farmzToken: tokenContract(),
      farmzClaim: claimContract(),
      signer: key ? signerAddress(key) : null,
      maxPerClaim: p.maxPerClaim,
      minPerClaim: p.minPerClaim,
      cooldownSeconds: p.cooldownSeconds,
    },
  });
}, ["GET"]);
