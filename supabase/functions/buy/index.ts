// POST { item, qty } — item is a shop item (feed) or an animal type.
import { ANIMALS, SHOP_ITEMS } from "../_shared/config.ts";
import { requirePlayer, rpc } from "../_shared/db.ts";
import { HttpError, int, json, readJson, serve, str } from "../_shared/http.ts";

serve(async (req) => {
  const player = await requirePlayer(req);
  const body = await readJson(req);
  const item = str(body, "item", 32);
  const qty = int(body, "qty", 1, 100);
  const animal = Object.hasOwn(ANIMALS, item) ? ANIMALS[item] : undefined;
  const shop = Object.hasOwn(SHOP_ITEMS, item) ? SHOP_ITEMS[item] : undefined;
  if (!animal && !shop) throw new HttpError(400, "UNKNOWN_ITEM");
  return json(
    await rpc("econ_buy", {
      p_player: player.id,
      p_item: item,
      p_qty: qty,
      p_unit_price: animal ? animal.price : shop!.price,
      p_animal_type: animal ? item : null,
      p_max_animals: animal ? animal.maxOwned : 0,
      p_min_level: animal ? animal.minLevel : shop!.minLevel,
    }),
  );
});
