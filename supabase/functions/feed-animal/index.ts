// POST { animalId } — consumes feed from inventory, starts the production timer.
import { animalsForSql } from "../_shared/config.ts";
import { requirePlayer, rpc } from "../_shared/db.ts";
import { json, readJson, serve, uuid } from "../_shared/http.ts";

serve(async (req) => {
  const player = await requirePlayer(req);
  const body = await readJson(req);
  return json(
    await rpc("econ_feed", { p_player: player.id, p_animal: uuid(body, "animalId"), p_animals: animalsForSql() }),
  );
});
