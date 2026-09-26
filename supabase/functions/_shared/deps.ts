// Pinned third-party imports (single place to bump versions).
export * from "npm:viem@2.56.8";
export { generatePrivateKey, privateKeyToAccount } from "npm:viem@2.56.8/accounts";
export { generateSiweNonce, parseSiweMessage } from "npm:viem@2.56.8/siwe";
export { base, baseSepolia } from "npm:viem@2.56.8/chains";
export { createClient } from "npm:@supabase/supabase-js@2.117.1";
export type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.1";
