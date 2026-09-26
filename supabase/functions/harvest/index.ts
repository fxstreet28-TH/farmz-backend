// POST { plotId } — server checks now() >= ready_at; yield comes from server config.
import { cropsForSql } from "../_shared/config.ts";
import { requirePlayer, rpc } from "../_shared/db.ts";
import { json, readJson, serve, uuid } from "../_shared/http.ts";

serve(async (req) => {
  const player = await requirePlayer(req);
  const body = await readJson(req);
  return json(await rpc("econ_harvest", { p_player: player.id, p_plot: uuid(body, "plotId"), p_crops: cropsForSql() }));
});
