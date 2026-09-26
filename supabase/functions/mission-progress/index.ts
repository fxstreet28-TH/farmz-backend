// INTERNAL ONLY. POST { playerId, kind, amount } with header x-internal-secret: <INTERNAL_API_SECRET>.
// Economy actions already update missions atomically inside their SQL transaction; this endpoint
// exists for other trusted server-side sources of progress (events, admin tools, future services).
import { rpc } from "../_shared/db.ts";
import { HttpError, int, json, readJson, serve, str, uuid } from "../_shared/http.ts";

const KINDS = new Set(["harvest_crops", "feed_animals", "sell_value", "login_streak", "complete_order"]);

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

serve(async (req) => {
  const secret = Deno.env.get("INTERNAL_API_SECRET");
  const given = req.headers.get("x-internal-secret") ?? "";
  if (!secret || secret.length < 32 || !timingSafeEqual(given, secret)) throw new HttpError(401, "UNAUTHORIZED");
  const body = await readJson(req);
  const kind = str(body, "kind", 32);
  if (!KINDS.has(kind)) throw new HttpError(400, "UNKNOWN_KIND");
  return json(
    await rpc("mission_progress_add", {
      p_player: uuid(body, "playerId"),
      p_kind: kind,
      p_amount: int(body, "amount", 1, 100000),
    }),
  );
});
