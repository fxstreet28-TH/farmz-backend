// Request/response helpers, CORS and error mapping.

export const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("CORS_ALLOW_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export class HttpError extends Error {
  constructor(public status: number, public code: string, public detail?: string) {
    super(code);
  }
}

// FZ:<CODE> errors raised by the SQL layer -> HTTP status.
const FZ_STATUS: Record<string, number> = {
  RATE_LIMITED: 429,
  INSUFFICIENT_COINS: 409,
  NOT_ENOUGH_ITEMS: 409,
  INVENTORY_FULL: 409,
  NOT_READY: 409,
  PLOT_NOT_EMPTY: 409,
  PLOT_EMPTY: 409,
  ALREADY_FED: 409,
  NOT_FED: 409,
  ANIMAL_LIMIT: 409,
  LEVEL_TOO_LOW: 403,
  ORDER_ALREADY_DONE: 409,
  CLAIM_PENDING: 409,
  CLAIM_COOLDOWN: 429,
  NOTHING_TO_CLAIM: 409,
  PLOT_NOT_FOUND: 404,
  ANIMAL_NOT_FOUND: 404,
  PLAYER_NOT_FOUND: 404,
  FARM_NOT_FOUND: 404,
  CLAIM_NOT_FOUND: 404,
};

export function fromDbError(err: { message?: string; details?: string | null; code?: string }): HttpError {
  const m = /^FZ:([A-Z_]+)/.exec(err.message ?? "");
  if (m) return new HttpError(FZ_STATUS[m[1]] ?? 400, m[1], err.details || undefined);
  console.error("db error", err);
  return new HttpError(500, "INTERNAL_ERROR");
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  if (req.method === "GET") return {} as T;
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "BAD_JSON");
  }
}

export function str(body: Record<string, unknown>, key: string, max = 128): string {
  const v = body[key];
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    throw new HttpError(400, "BAD_REQUEST", `${key} required`);
  }
  return v;
}

export function uuid(body: Record<string, unknown>, key: string): string {
  const v = str(body, key, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    throw new HttpError(400, "BAD_REQUEST", `${key} must be a uuid`);
  }
  return v;
}

export function int(body: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = body[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, "BAD_REQUEST", `${key} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

/** Wraps a handler with CORS preflight, method check and error mapping. */
export function serve(handler: (req: Request) => Promise<Response>, methods = ["POST"]) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (!methods.includes(req.method)) return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, detail: e.detail }, e.status);
      console.error(e);
      return json({ error: "INTERNAL_ERROR" }, 500);
    }
  });
}
