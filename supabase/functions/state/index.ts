// GET/POST -> full game state for the calling player (server time included).
import { requirePlayer, rpc } from "../_shared/db.ts";
import { json, serve } from "../_shared/http.ts";

serve(async (req) => {
  const player = await requirePlayer(req);
  return json(await rpc("game_state", { p_player: player.id }));
}, ["GET", "POST"]);
