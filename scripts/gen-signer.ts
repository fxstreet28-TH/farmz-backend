// Generates a NEW claim-signer keypair locally. Run on a trusted machine:
//   deno run scripts/gen-signer.ts
// Then: supabase secrets set CLAIM_SIGNER_PRIVATE_KEY=<key>   (never commit / paste it anywhere)
// and set the printed ADDRESS as trusted signer on FarmZClaim (setTrustedSigner).
import { generatePrivateKey, privateKeyToAccount } from "../supabase/functions/_shared/deps.ts";

const key = generatePrivateKey();
console.log(`ADDRESS=${privateKeyToAccount(key).address}`);
console.log(`CLAIM_SIGNER_PRIVATE_KEY=${key}`);
console.error("\n⚠️  Store the private key only in Supabase secrets / a password manager. Share only the ADDRESS.");
