import { type Address, createPublicClient, http, parseAbi } from "./deps.ts";
import { base, baseSepolia } from "./deps.ts";
import { chainId, claimContract, rpcUrl } from "./env.ts";

export const FARMZ_CLAIM_ABI = parseAbi([
  "function nonceUsed(address account, uint256 nonce) view returns (bool)",
  "function trustedSigner() view returns (address)",
  "function paused() view returns (bool)",
  "function hashClaim(address account, uint256 amount, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "event Claimed(address indexed account, uint256 amount, uint256 indexed nonce)",
]);

export function publicClient() {
  const chain = chainId() === base.id ? base : baseSepolia;
  return createPublicClient({ chain, transport: http(rpcUrl()) });
}

export function isNonceUsed(account: Address, nonce: bigint): Promise<boolean> {
  return publicClient().readContract({
    address: claimContract(),
    abi: FARMZ_CLAIM_ABI,
    functionName: "nonceUsed",
    args: [account, nonce],
  });
}
