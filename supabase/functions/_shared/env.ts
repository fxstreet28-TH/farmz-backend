import { type Address, getAddress, type Hex } from "./deps.ts";

export function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export const chainId = () => Number(Deno.env.get("CHAIN_ID") ?? "84532");
export const claimContract = (): Address =>
  getAddress(Deno.env.get("FARMZ_CLAIM_ADDRESS") ?? "0xCd1602e8bbCacC20b1be251B572f663484E8702c");
export const tokenContract = (): Address =>
  getAddress(Deno.env.get("FARMZ_TOKEN_ADDRESS") ?? "0xaA3639f77A827C5C8B16F7dB44aA4F54542Bb26B");
export const rpcUrl = () => Deno.env.get("BASE_SEPOLIA_RPC_URL") ?? "https://sepolia.base.org";

/** Returns the signer key or null when not configured (claim endpoints then answer 503). */
export function signerKey(): Hex | null {
  const k = Deno.env.get("CLAIM_SIGNER_PRIVATE_KEY")?.trim();
  if (!k) return null;
  const hex = (k.startsWith("0x") ? k : `0x${k}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("CLAIM_SIGNER_PRIVATE_KEY is malformed");
  return hex;
}

export const siweAllowedDomains = () =>
  (Deno.env.get("SIWE_ALLOWED_DOMAINS") ?? "localhost:3000,localhost:5173")
    .split(",").map((d) => d.trim()).filter(Boolean);

export const walletEmailDomain = () => Deno.env.get("WALLET_EMAIL_DOMAIN") ?? "wallet.farmz.invalid";
