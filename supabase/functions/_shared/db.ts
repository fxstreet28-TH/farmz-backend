import { createClient, type SupabaseClient } from "./deps.ts";
import { requireEnv } from "./env.ts";
import { fromDbError, HttpError } from "./http.ts";

let admin: SupabaseClient | null = null;

/** Service-role client. Never expose to clients; bypasses RLS. */
export function adminClient(): SupabaseClient {
  admin ??= createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}

export function anonClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await adminClient().rpc(fn, args);
  if (error) throw fromDbError(error);
  return data as T;
}

export interface Player {
  id: string;
  wallet: `0x${string}`;
}

/** Resolves the calling player from the Supabase session JWT (Authorization: Bearer <access_token>). */
export async function requirePlayer(req: Request): Promise<Player> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "UNAUTHORIZED");
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "UNAUTHORIZED");
  const { data: player, error: pErr } = await adminClient()
    .from("players").select("id, wallet").eq("id", data.user.id).maybeSingle();
  if (pErr) throw fromDbError(pErr);
  if (!player) throw new HttpError(401, "NO_PLAYER");
  return player as Player;
}
