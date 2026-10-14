import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ADAPTER_ABI,
  PROXY_FACTORY_ABI,
  REDEEM_CONTRACTS,
  SAFE_ABI,
  buildRoutedTx,
  preValidatedSignature,
  redeemCall,
  routeForSignatureType,
  selectRedeemable,
  type DataApiPosition,
} from "../src/execution/redeem";

const CID_A = `0x${"a".repeat(64)}`;
const CID_B = `0x${"b".repeat(64)}`;
const CID_C = `0x${"c".repeat(64)}`;

const pos = (o: Partial<DataApiPosition>): DataApiPosition => ({
  conditionId: CID_A,
  asset: "1",
  size: 10,
  curPrice: 1,
  redeemable: true,
  negativeRisk: false,
  slug: "btc-updown-5m-1792000800",
  ...o,
});

describe("selectRedeemable", () => {
  const opts = { assets: ["btc", "eth"], scope: "updown" as const, minPayoutUsd: 1 };

  it("groups both outcomes of a condition and values them at the settlement price", () => {
    const out = selectRedeemable(
      [pos({ asset: "1", size: 10, curPrice: 1 }), pos({ asset: "2", size: 10, curPrice: 0 })],
      opts,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].conditionId, CID_A);
    assert.equal(out[0].shares, 20);
    assert.equal(out[0].expectedPayout, 10);
  });

  it("skips losers below the minimum, neg-risk, other assets and non-redeemable rows", () => {
    const out = selectRedeemable(
      [
        pos({ conditionId: CID_A, curPrice: 0 }),
        pos({ conditionId: CID_B, negativeRisk: true }),
        pos({ conditionId: CID_C, slug: "sol-updown-5m-1792000800" }),
        pos({ conditionId: CID_C, redeemable: false, slug: "eth-updown-15m-1792000800" }),
      ],
      opts,
    );
    assert.deepEqual(out, []);
  });

  it("includes any binary market with scope all, largest payout first", () => {
    const out = selectRedeemable(
      [pos({ conditionId: CID_A, size: 2, slug: "will-it-rain" }), pos({ conditionId: CID_B, size: 50, slug: "eth-updown-15m-1" })],
      { ...opts, scope: "all" },
    );
    assert.deepEqual(
      out.map((c) => c.conditionId),
      [CID_B, CID_A],
    );
  });
});

describe("redeem transactions", () => {
  const holder = "0x9d57c42e847173d06841703825d3fe2299e456ea";
  const signer = "0xAB891669F394c5bb1680E1f8513ce58dB9d2F839";

  it("maps signature types to routes", () => {
    assert.equal(routeForSignatureType(0), "eoa");
    assert.equal(routeForSignatureType(1), "proxy");
    assert.equal(routeForSignatureType(2), "safe");
    assert.equal(routeForSignatureType(3), null);
  });

  it("calls the collateral adapter with pUSD and both index sets", async () => {
    const { decodeFunctionData } = await import("viem");
    const call = await redeemCall(CID_A as `0x${string}`);
    assert.equal(call.to, REDEEM_CONTRACTS.ctfCollateralAdapter);
    const d = decodeFunctionData({ abi: ADAPTER_ABI, data: call.data });
    assert.equal(d.functionName, "redeemPositions");
    assert.deepEqual(d.args, [REDEEM_CONTRACTS.collateral, `0x${"0".repeat(64)}`, CID_A, [1n, 2n]]);
  });

  it("sends EOA calls as is", async () => {
    const call = await redeemCall(CID_A as `0x${string}`);
    assert.deepEqual(await buildRoutedTx("eoa", signer, signer, call), call);
  });

  it("wraps proxy-wallet calls in ProxyWalletFactory.proxy", async () => {
    const { decodeFunctionData } = await import("viem");
    const call = await redeemCall(CID_A as `0x${string}`);
    const tx = await buildRoutedTx("proxy", holder, signer, call);
    assert.equal(tx.to, REDEEM_CONTRACTS.proxyFactory);
    const d = decodeFunctionData({ abi: PROXY_FACTORY_ABI, data: tx.data });
    assert.deepEqual(d.args[0], [{ typeCode: 1, to: call.to, value: 0n, data: call.data }]);
  });

  it("wraps Safe calls in execTransaction with the owner's pre-validated signature", async () => {
    const { decodeFunctionData } = await import("viem");
    const call = await redeemCall(CID_A as `0x${string}`);
    const tx = await buildRoutedTx("safe", holder, signer, call);
    assert.equal(tx.to, holder);
    const d = decodeFunctionData({ abi: SAFE_ABI, data: tx.data });
    assert.equal(d.functionName, "execTransaction");
    const args = d.args as readonly unknown[];
    assert.equal(args[0], call.to);
    assert.equal(args[2], call.data);
    assert.equal(args[3], 0, "CALL, not DELEGATECALL");
    assert.equal(args[9], preValidatedSignature(signer));
  });

  it("encodes the pre-validated signature as r=owner, s=0, v=1", () => {
    const sig = preValidatedSignature(signer);
    assert.equal(sig.length, 2 + 65 * 2);
    assert.equal(sig.slice(2, 66), signer.slice(2).toLowerCase().padStart(64, "0"));
    assert.equal(sig.slice(66, 130), "0".repeat(64));
    assert.equal(sig.slice(130), "01");
  });
});
