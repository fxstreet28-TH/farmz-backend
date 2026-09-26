import { assert } from "jsr:@std/assert@1";
import { ANIMALS, CROPS, ORDERS, SELL_PRICES, SHOP_ITEMS } from "../supabase/functions/_shared/config.ts";

Deno.test("every crop is profitable but not free money", () => {
  for (const [k, c] of Object.entries(CROPS)) {
    assert(c.seedPrice > 0 && c.growSeconds > 0 && c.yield > 0, k);
    assert(c.yield * c.sellPrice > c.seedPrice, `${k} should be profitable`);
    assert(SELL_PRICES[k] === c.sellPrice, `${k} sell price`);
  }
});

Deno.test("animals reference existing feed and sellable produce", () => {
  for (const [k, a] of Object.entries(ANIMALS)) {
    assert(SHOP_ITEMS[a.feedItem], `${k} feed ${a.feedItem} must be buyable`);
    assert(SELL_PRICES[a.produce] > 0, `${k} produce ${a.produce} must be sellable`);
    assert(!SHOP_ITEMS[k], `${k} must not collide with a shop item`);
  }
});

Deno.test("orders use only producible items", () => {
  for (const [k, o] of Object.entries(ORDERS)) {
    for (const item of Object.keys(o.items)) assert(SELL_PRICES[item] !== undefined, `${k}: ${item}`);
  }
});
