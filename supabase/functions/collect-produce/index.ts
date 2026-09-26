// POST { animalId } — server checks now() >= produce_ready_at.
import { animalsForSql } from "../_shared/config.ts";
import { requirePlayer, rpc } from "../_shared/db.ts";
import { json, readJson, serve, uuid } from "../_shared/http.ts";

serve(async (req) => {
  const player = await requirePlayer(req);
  const body = await readJson(req);
  return json(
    await rpc("econ_collect", { p_player: player.id, p_animal: uuid(body, "animalId"), p_animals: animalsForSql() }),
  );
});
