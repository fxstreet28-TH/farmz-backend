// Proves the backend's EIP-712 signatures are exactly what FarmZClaim accepts.
//
// GOLDEN was produced by the real FarmZClaim bytecode from farmz-contracts (Hardhat, chainId 31337):
// deploy FarmZ + FarmZClaim, setTrustedSigner(signer), unpause, compute hashClaim(...) on-chain,
// sign with ethers signTypedData, then FarmZClaim.claim(...) SUCCEEDED and minted 12.5 FARMZ.
// Matching these values byte-for-byte means our domain/types/encoding equal the contract's.
import { assertEquals } from "jsr:@std/assert@1";
import {
  concat,
  encodeAbiParameters,
  generatePrivateKey,
  getAddress,
  type Hex,
  keccak256,
  privateKeyToAccount,
  toBytes,
} from "../supabase/functions/_shared/deps.ts";
import {
  claimDomain,
  hashClaim,
  randomNonce,
  recoverClaimSigner,
  signClaim,
  signerAddress,
} from "../supabase/functions/_shared/eip712.ts";

const GOLDEN = {
  chainId: 31337,
  verifyingContract: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  // Hardhat default account #1 — a publicly known TEST key, never used on a real network.
  signerKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
  signer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  account: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  amountWei: 12500000000000000000n,
  nonce: 6295027170268925931501798714381296663804795307364110822320284261939154273622n,
  deadline: 4102444800n,
  // values returned by the deployed contract
  claimTypehash: "0x59ab0198ee5acabc4b507660abee57e25793713a925b00881a239217fc3b93d3",
  domainSeparator: "0x37cd4fe964e585fb6cc30aaeb3986b3e28d66f46e4d05f6ac827cbd9991a6d99",
  digest: "0x27833e5cf9a228ff55d8924e9da60d17d0a6c3d16fd009a41bcadeb4306f77cb",
  signature:
    "0x5df0f5e49204dcef54aca22a699d5437e93a6b5762912be7edce13b130f7415e406e13f03d41fed077affe63158bd5ed01acf9134ed30f1303c49cfa607e87ce1c",
};

const goldenDomain = () => claimDomain(GOLDEN.chainId, GOLDEN.verifyingContract);
const goldenMessage = () => ({
  account: getAddress(GOLDEN.account),
  amount: GOLDEN.amountWei,
  nonce: GOLDEN.nonce,
  deadline: GOLDEN.deadline,
});

Deno.test("CLAIM_TYPEHASH matches FarmZClaim.CLAIM_TYPEHASH", () => {
  assertEquals(
    keccak256(toBytes("Claim(address account,uint256 amount,uint256 nonce,uint256 deadline)")),
    GOLDEN.claimTypehash,
  );
});

Deno.test("domain separator matches FarmZClaim.domainSeparator()", () => {
  const d = goldenDomain();
  const sep = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [
      keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
      keccak256(toBytes(d.name)),
      keccak256(toBytes(d.version)),
      BigInt(d.chainId),
      d.verifyingContract,
    ],
  ));
  assertEquals(sep, GOLDEN.domainSeparator);
});

Deno.test("hashClaim equals the on-chain FarmZClaim.hashClaim digest", () => {
  assertEquals(hashClaim(goldenDomain(), goldenMessage()), GOLDEN.digest);
  // and equals the manual EIP-712 construction
  const m = goldenMessage();
  const structHash = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [GOLDEN.claimTypehash as Hex, m.account, m.amount, m.nonce, m.deadline],
  ));
  assertEquals(keccak256(concat(["0x1901", GOLDEN.domainSeparator as Hex, structHash])), GOLDEN.digest);
});

Deno.test("signClaim reproduces the signature the contract accepted", async () => {
  assertEquals(signerAddress(GOLDEN.signerKey), GOLDEN.signer);
  const sig = await signClaim(GOLDEN.signerKey, goldenDomain(), goldenMessage());
  assertEquals(sig, GOLDEN.signature);
  assertEquals(await recoverClaimSigner(goldenDomain(), goldenMessage(), sig), GOLDEN.signer);
});

Deno.test("production domain (Base Sepolia FarmZClaim): signature recovers to the signer", async () => {
  const key = generatePrivateKey();
  const domain = claimDomain(84532, "0xCd1602e8bbCacC20b1be251B572f663484E8702c");
  assertEquals(domain.verifyingContract, "0xCd1602e8bbCacC20b1be251B572f663484E8702c");
  const msg = {
    account: privateKeyToAccount(generatePrivateKey()).address,
    amount: 1000n * 10n ** 18n,
    nonce: randomNonce(),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };
  const sig = await signClaim(key, domain, msg);
  assertEquals(await recoverClaimSigner(domain, msg, sig), privateKeyToAccount(key).address);
});

Deno.test("tampered fields do not recover to the signer", async () => {
  const d = goldenDomain(), m = goldenMessage();
  const sig = GOLDEN.signature as Hex;
  for (
    const bad of [
      { ...m, amount: m.amount + 1n },
      { ...m, nonce: m.nonce + 1n },
      { ...m, deadline: m.deadline + 1n },
      { ...m, account: getAddress(GOLDEN.signer) },
    ]
  ) {
    const r = await recoverClaimSigner(d, bad, sig);
    if (r === GOLDEN.signer) throw new Error("tampered message still recovered to signer");
  }
  const otherChain = claimDomain(84532, GOLDEN.verifyingContract);
  if ((await recoverClaimSigner(otherChain, m, sig)) === GOLDEN.signer) throw new Error("cross-chain replay");
});

Deno.test("randomNonce is a uint256 and unique", () => {
  const seen = new Set<bigint>();
  for (let i = 0; i < 1000; i++) {
    const n = randomNonce();
    if (n < 0n || n >= 2n ** 256n) throw new Error("out of range");
    seen.add(n);
  }
  assertEquals(seen.size, 1000);
});
