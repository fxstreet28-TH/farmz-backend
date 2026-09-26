// EIP-712 signing for FarmZClaim. MUST match contracts/FarmZClaim.sol in farmz-contracts:
//   EIP712("FarmZClaim", "1")
//   Claim(address account,uint256 amount,uint256 nonce,uint256 deadline)
// Any change to names, field order or types makes every signature invalid on-chain.
import {
  type Address,
  getAddress,
  hashTypedData,
  type Hex,
  privateKeyToAccount,
  recoverTypedDataAddress,
} from "./deps.ts";

export const CLAIM_DOMAIN_NAME = "FarmZClaim";
export const CLAIM_DOMAIN_VERSION = "1";

export const CLAIM_TYPES = {
  Claim: [
    { name: "account", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface ClaimDomain {
  name: typeof CLAIM_DOMAIN_NAME;
  version: typeof CLAIM_DOMAIN_VERSION;
  chainId: number;
  verifyingContract: Address;
}

export interface ClaimMessage {
  account: Address;
  amount: bigint; // wei (18 decimals)
  nonce: bigint; // uint256, unique per account
  deadline: bigint; // unix seconds
}

export function claimDomain(chainId: number, verifyingContract: string): ClaimDomain {
  return {
    name: CLAIM_DOMAIN_NAME,
    version: CLAIM_DOMAIN_VERSION,
    chainId,
    verifyingContract: getAddress(verifyingContract),
  };
}

/** Digest that FarmZClaim.hashClaim(account, amount, nonce, deadline) returns on-chain. */
export function hashClaim(domain: ClaimDomain, message: ClaimMessage): Hex {
  return hashTypedData({ domain, types: CLAIM_TYPES, primaryType: "Claim", message });
}

export function signClaim(privateKey: Hex, domain: ClaimDomain, message: ClaimMessage): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  return account.signTypedData({ domain, types: CLAIM_TYPES, primaryType: "Claim", message });
}

export function recoverClaimSigner(domain: ClaimDomain, message: ClaimMessage, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ domain, types: CLAIM_TYPES, primaryType: "Claim", message, signature });
}

export function signerAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

/** Random uint256 nonce (FarmZClaim tracks used nonces per account, they need not be sequential). */
export function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
}
