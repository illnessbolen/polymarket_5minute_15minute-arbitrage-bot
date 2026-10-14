/**
 * Building blocks for redeeming resolved positions.
 *
 * Since CLOB V2 the outcome tokens are still Conditional Tokens (backed by
 * USDC.e), but winnings are paid in pUSD through Polymarket's
 * CtfCollateralAdapter:
 *
 *   CtfCollateralAdapter.redeemPositions(pUSD, 0x0, conditionId, [1, 2])
 *
 * The adapter pulls the caller's outcome tokens (it must be an approved
 * ERC-1155 operator of the holder) and pays 1 pUSD per winning share.
 * Addresses: https://docs.polymarket.com/resources/contracts
 *
 * The call is sent by the signing key and routed by wallet type:
 *   EOA   (0) the key holds the tokens and calls the adapter directly
 *   proxy (1) ProxyWalletFactory.proxy([...]) forwards the call through the
 *             key's Polymarket proxy wallet
 *   safe  (2) Safe.execTransaction(...) signed with the owner's pre-validated
 *             signature (valid because the owner itself sends it)
 */

export const REDEEM_CONTRACTS = {
  conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  ctfCollateralAdapter: "0xAdA100Db00Ca00073811820692005400218FcE1f",
  collateral: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  proxyFactory: "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052",
  /** Implementation behind every Polymarket proxy wallet (EIP-1167 clone). */
  proxyImplementation: "0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f",
} as const;

const ZERO_HASH = `0x${"0".repeat(64)}` as const;
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as const;

export type Hex = `0x${string}`;
export type WalletRoute = "eoa" | "proxy" | "safe";

export interface TxRequest {
  to: Hex;
  data: Hex;
}

export const ADAPTER_ABI = [
  {
    type: "function",
    name: "redeemPositions",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

export const CTF_ABI = [
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "payoutDenominator",
    stateMutability: "view",
    inputs: [{ name: "conditionId", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const PROXY_FACTORY_ABI = [
  {
    type: "function",
    name: "proxy",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "typeCode", type: "uint8" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "returnValues", type: "bytes[]" }],
  },
] as const;

export const SAFE_ABI = [
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Map POLY_SIGNATURE_TYPE to a redemption route; deposit wallets (3) are not supported. */
export function routeForSignatureType(signatureType: number): WalletRoute | null {
  if (signatureType === 0) return "eoa";
  if (signatureType === 1) return "proxy";
  if (signatureType === 2) return "safe";
  return null;
}

/** A position as returned by https://data-api.polymarket.com/positions. */
export interface DataApiPosition {
  conditionId: string;
  asset: string;
  size: number;
  curPrice: number;
  redeemable: boolean;
  negativeRisk?: boolean;
  slug?: string;
  outcome?: string;
}

export interface RedeemCandidate {
  conditionId: Hex;
  slug: string;
  shares: number;
  /** Payout implied by the data API (winning shares x 1). */
  expectedPayout: number;
}

export interface SelectOptions {
  assets: string[];
  /** "updown": only <asset>-updown-5m/15m markets of the configured assets; "all": every binary market. */
  scope: "updown" | "all";
  minPayoutUsd: number;
}

/** Group redeemable binary positions by condition and keep those worth a transaction. */
export function selectRedeemable(positions: DataApiPosition[], opts: SelectOptions): RedeemCandidate[] {
  const slugPattern = new RegExp(`^(${opts.assets.map((a) => a.toLowerCase()).join("|")})-updown-(5m|15m)-\\d+$`);
  const byCondition = new Map<string, RedeemCandidate>();
  for (const p of positions) {
    if (!p.redeemable || p.negativeRisk || !(p.size > 0)) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(p.conditionId)) continue;
    const slug = p.slug ?? "";
    if (opts.scope === "updown" && !slugPattern.test(slug)) continue;
    const c = byCondition.get(p.conditionId) ?? { conditionId: p.conditionId as Hex, slug, shares: 0, expectedPayout: 0 };
    c.shares += p.size;
    c.expectedPayout += p.size * (Number(p.curPrice) || 0);
    byCondition.set(p.conditionId, c);
  }
  return [...byCondition.values()]
    .filter((c) => c.expectedPayout >= opts.minPayoutUsd)
    .sort((a, b) => b.expectedPayout - a.expectedPayout);
}

/**
 * Safe "pre-validated" signature: r = owner address, s = 0, v = 1.
 * Accepted by Safe v1.3 when msg.sender is that owner.
 */
export function preValidatedSignature(owner: string): Hex {
  const addr = owner.toLowerCase().replace(/^0x/, "");
  return `0x${addr.padStart(64, "0")}${"0".repeat(64)}01`;
}

/**
 * Transaction the signing key sends so that `call` executes with the holder
 * (EOA, proxy wallet or Safe) as msg.sender.
 */
export async function buildRoutedTx(route: WalletRoute, holder: string, signer: string, call: TxRequest): Promise<TxRequest> {
  const { encodeFunctionData } = await import("viem");
  switch (route) {
    case "eoa":
      return call;
    case "proxy":
      return {
        to: REDEEM_CONTRACTS.proxyFactory,
        data: encodeFunctionData({
          abi: PROXY_FACTORY_ABI,
          functionName: "proxy",
          args: [[{ typeCode: 1, to: call.to, value: 0n, data: call.data }]],
        }),
      };
    case "safe":
      return {
        to: holder as Hex,
        data: encodeFunctionData({
          abi: SAFE_ABI,
          functionName: "execTransaction",
          args: [call.to, 0n, call.data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, preValidatedSignature(signer)],
        }),
      };
  }
}

export async function redeemCall(conditionId: Hex): Promise<TxRequest> {
  const { encodeFunctionData } = await import("viem");
  return {
    to: REDEEM_CONTRACTS.ctfCollateralAdapter,
    data: encodeFunctionData({
      abi: ADAPTER_ABI,
      functionName: "redeemPositions",
      args: [REDEEM_CONTRACTS.collateral, ZERO_HASH, conditionId, [1n, 2n]],
    }),
  };
}

export async function approveAdapterCall(): Promise<TxRequest> {
  const { encodeFunctionData } = await import("viem");
  return {
    to: REDEEM_CONTRACTS.conditionalTokens,
    data: encodeFunctionData({
      abi: CTF_ABI,
      functionName: "setApprovalForAll",
      args: [REDEEM_CONTRACTS.ctfCollateralAdapter, true],
    }),
  };
}
