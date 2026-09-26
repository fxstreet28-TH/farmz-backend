// POST { plotId, cropId } — seed cost and grow time come from server config.
import { CROPS } from "../_shared/config.ts";
import { requirePlayer, rpc } from "../_shared/db.ts";
import { HttpError, json, readJson, serve, str, uuid } from "../_shared/http.ts";

serve(async (req) => {
  const player = await requirePlayer(req);
  const body = await readJson(req);
  const plotId = uuid(body, "plotId");
  const cropId = str(body, "cropId", 32);
  const crop = Object.hasOwn(CROPS, cropId) ? CROPS[cropId] : undefined;
  if (!crop) throw new HttpError(400, "UNKNOWN_CROP");
  return json(
    await rpc("econ_plant", {
      p_player: player.id,
      p_plot: plotId,
      p_crop: cropId,
      p_seed_cost: crop.seedPrice,
      p_grow_seconds: crop.growSeconds,
      p_min_level: crop.minLevel,
    }),
  );
});
