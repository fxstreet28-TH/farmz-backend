// POST { orderId } — delivers the order's items from inventory for a coin reward (once per day).
import { ORDERS } from "../_shared/config.ts";
import { requirePlayer, rpc } from "../_shared/db.ts";
import { HttpError, json, readJson, serve, str } from "../_shared/http.ts";

serve(async (req) => {
  const player = await requirePlayer(req);
  const body = await readJson(req);
  const orderId = str(body, "orderId", 64);
  const order = Object.hasOwn(ORDERS, orderId) ? ORDERS[orderId] : undefined;
  if (!order) throw new HttpError(400, "UNKNOWN_ORDER");
  return json(
    await rpc("econ_complete_order", {
      p_player: player.id,
      p_order: orderId,
      p_items: order.items,
      p_reward_coin: order.rewardCoin,
      p_reward_xp: order.rewardXp,
    }),
  );
});
