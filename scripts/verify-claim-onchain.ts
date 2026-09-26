// Verifies the backend signer against the LIVE FarmZClaim contract (read-only, no gas):
//  - on-chain eip712Domain() == backend domain
//  - on-chain hashClaim(...) == backend hashClaim(...)
//  - signature from CLAIM_SIGNER_PRIVATE_KEY recovers to the key's address
//  - FarmZClaim.trustedSigner() == that address (after setTrustedSigner)
//
// deno run --allow-net --allow-env --allow-read scripts/verify-claim-onchain.ts
// env: CLAIM_SIGNER_PRIVATE_KEY (or CLAIM_SIGNER_ADDRESS to only check the domain/hash/signer),
//      BASE_SEPOLIA_RPC_URL, FARMZ_CLAIM_ADDRESS, CHAIN_ID (defaults: Base Sepolia deployment)
import { getAddress, isAddressEqual } from "../supabase/functions/_shared/deps.ts";
import { FARMZ_CLAIM_ABI, publicClient } from "../supabase/functions/_shared/chain.ts";
import { chainId, claimContract, signerKey } from "../supabase/functions/_shared/env.ts";
import {
  claimDomain,
  hashClaim,
  randomNonce,
  recoverClaimSigner,
  signClaim,
  signerAddress,
} from "../supabase/functions/_shared/eip712.ts";

const client = publicClient();
const address = claimContract();
const domain = claimDomain(chainId(), address);
let ok = true;
const check = (label: string, pass: boolean, extra = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);
  ok &&= pass;
};

const [, name, version, onChainId, verifyingContract] = await client.readContract({
  address,
  abi: FARMZ_CLAIM_ABI,
  functionName: "eip712Domain",
});
check("eip712Domain.name", name === domain.name, name);
check("eip712Domain.version", version === domain.version, version);
check("eip712Domain.chainId", Number(onChainId) === domain.chainId, String(onChainId));
check("eip712Domain.verifyingContract", isAddressEqual(verifyingContract, domain.verifyingContract), verifyingContract);

const key = signerKey();
const signer = key
  ? signerAddress(key)
  : getAddress(Deno.env.get("CLAIM_SIGNER_ADDRESS") ?? "0x0000000000000000000000000000000000000001");
const msg = {
  account: getAddress("0x000000000000000000000000000000000000dEaD"),
  amount: 10n ** 18n,
  nonce: randomNonce(),
  deadline: 4102444800n,
};
const onChainDigest = await client.readContract({
  address,
  abi: FARMZ_CLAIM_ABI,
  functionName: "hashClaim",
  args: [msg.account, msg.amount, msg.nonce, msg.deadline],
});
check("hashClaim(on-chain) == hashClaim(backend)", onChainDigest === hashClaim(domain, msg), onChainDigest);

if (key) {
  const sig = await signClaim(key, domain, msg);
  check("signature recovers to signer", isAddressEqual(await recoverClaimSigner(domain, msg, sig), signer), signer);
}
const trusted = await client.readContract({ address, abi: FARMZ_CLAIM_ABI, functionName: "trustedSigner" });
check("FarmZClaim.trustedSigner() == backend signer", isAddressEqual(trusted, signer), `on-chain ${trusted}`);
const paused = await client.readContract({ address, abi: FARMZ_CLAIM_ABI, functionName: "paused" });
console.log(`INFO  FarmZClaim.paused() = ${paused}`);

Deno.exit(ok ? 0 : 1);
