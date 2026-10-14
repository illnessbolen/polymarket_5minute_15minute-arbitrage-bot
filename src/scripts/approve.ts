/**
 * One-time on-chain approvals for an EOA wallet (POLY_SIGNATURE_TYPE=0):
 *   - collateral (pUSD) allowance for the CTF Exchange V2
 *   - conditional-token (ERC-1155) operator approval for the exchange (needed to sell)
 *
 * Polymarket proxy / Safe wallets (signature types 1 and 2) are approved by
 * Polymarket when you deposit through the website; this script is not needed.
 *
 * Usage: npm run approve            # show current state
 *        npm run approve -- --yes   # send the missing approval transactions
 */

import "dotenv/config";
import { getContractConfig } from "@polymarket/clob-client-v2";
import { loadConfig } from "../config";

const ERC20_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const ERC1155_ABI = [
  { type: "function", name: "isApprovedForAll", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "operator", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "setApprovalForAll", stateMutability: "nonpayable", inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [] },
] as const;

async function main(): Promise<void> {
  const send = process.argv.includes("--yes");
  const cfg = loadConfig();
  if (!cfg.privateKey) throw new Error("Set POLY_PRIVATE_KEY in .env");
  if (cfg.signatureType !== 0) {
    console.log("POLY_SIGNATURE_TYPE is not 0 (EOA): Polymarket manages approvals for proxy/Safe wallets. Nothing to do.");
    return;
  }

  const { createPublicClient, createWalletClient, http, maxUint256, formatUnits } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { polygon } = await import("viem/chains");

  const contracts = getContractConfig(137);
  const key = (cfg.privateKey.startsWith("0x") ? cfg.privateKey : `0x${cfg.privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain: polygon, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account, chain: polygon, transport: http(cfg.rpcUrl) });

  const collateral = contracts.collateral as `0x${string}`;
  const ctf = contracts.conditionalTokens as `0x${string}`;
  const exchange = contracts.exchangeV2 as `0x${string}`;

  const [gas, balance, allowance, operator] = await Promise.all([
    pub.getBalance({ address: account.address }),
    pub.readContract({ address: collateral, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
    pub.readContract({ address: collateral, abi: ERC20_ABI, functionName: "allowance", args: [account.address, exchange] }),
    pub.readContract({ address: ctf, abi: ERC1155_ABI, functionName: "isApprovedForAll", args: [account.address, exchange] }),
  ]);

  console.log(`Wallet:               ${account.address}`);
  console.log(`POL for gas:          ${formatUnits(gas, 18)}`);
  console.log(`Collateral (pUSD):    ${formatUnits(balance, 6)}  [${collateral}]`);
  console.log(`Exchange V2:          ${exchange}`);
  console.log(`  collateral allowance: ${allowance >= maxUint256 / 2n ? "unlimited" : formatUnits(allowance, 6)}`);
  console.log(`  token approval:       ${operator ? "yes" : "no"}`);

  const todo: Array<{ label: string; run: () => Promise<`0x${string}`> }> = [];
  if (allowance < maxUint256 / 2n) {
    todo.push({
      label: "approve collateral for Exchange V2",
      run: () => wallet.writeContract({ address: collateral, abi: ERC20_ABI, functionName: "approve", args: [exchange, maxUint256] }),
    });
  }
  if (!operator) {
    todo.push({
      label: "approve outcome tokens for Exchange V2",
      run: () => wallet.writeContract({ address: ctf, abi: ERC1155_ABI, functionName: "setApprovalForAll", args: [exchange, true] }),
    });
  }

  if (todo.length === 0) {
    console.log("\nAll approvals are in place.");
    return;
  }
  if (!send) {
    console.log(`\nMissing: ${todo.map((t) => t.label).join("; ")}.\nRun \`npm run approve -- --yes\` to send ${todo.length} transaction(s).`);
    return;
  }
  for (const t of todo) {
    const hash = await t.run();
    console.log(`${t.label}: ${hash}`);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${receipt.status} in block ${receipt.blockNumber}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
