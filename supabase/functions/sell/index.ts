// POST { item, qty } — price from server config; diminishing returns if selling abnormally often.
import { SELL_PRICES } from "../_shared/config.ts";
import { requirePlayer, rpc } from "../_shared/db.ts";
import { HttpError, int, json, readJson, serve, str } from "../_shared/http.ts";

serve(async (req) => {
  const player = await requirePlayer(req);
  const body = await readJson(req);
  const item = str(body, "item", 32);
  const qty = int(body, "qty", 1, 1000);
  const price = Object.hasOwn(SELL_PRICES, item) ? SELL_PRICES[item] : undefined;
  if (!price) throw new HttpError(400, "NOT_SELLABLE");
  return json(await rpc("econ_sell", { p_player: player.id, p_item: item, p_qty: qty, p_unit_price: price }));
});
