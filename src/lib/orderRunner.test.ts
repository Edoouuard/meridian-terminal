import { describe, expect, it } from "vitest";
import type { Order } from "@/lib/execution";
import { executePreparedOrder, prepareOrder, type OrderRunnerClient, type OrderRunnerDeps } from "@/lib/orderRunner";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const SENDER = "0x1111111111111111111111111111111111111111";
const AMOUNT = 1_000_000_000n; // 1000 USDC/USDT, 6 decimals

const supply = (token: string = USDC): Order => ({
  type: "supply",
  protocol: "aave",
  token: token as `0x${string}`,
  symbol: "USDC",
  amount: "1000",
  chainId: 1,
  decimals: 6,
});

interface FakeOptions {
  balance?: bigint;
  allowance?: bigint;
  failSimulation?: (fn: string) => boolean;
  receiptStatus?: "success" | "reverted";
}

function fakeDeps(opts: FakeOptions = {}, connectedChainId = 1) {
  const writes: { functionName: string; args: readonly unknown[] }[] = [];
  const simulations: string[] = [];
  let allowance = opts.allowance ?? 0n;
  const client: OrderRunnerClient = {
    getBalance: async () => opts.balance ?? AMOUNT,
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "balanceOf" ? (opts.balance ?? AMOUNT) : allowance,
    simulateContract: async ({ functionName }: { functionName: string }) => {
      simulations.push(functionName);
      if (opts.failSimulation?.(functionName)) throw new Error("execution reverted");
    },
    call: async () => undefined,
    waitForTransactionReceipt: async () => ({ status: opts.receiptStatus ?? "success" }),
  };
  const deps: OrderRunnerDeps = {
    address: SENDER,
    connectedChainId,
    client,
    writeContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      writes.push({ functionName, args });
      if (functionName === "approve") allowance = args[1] as bigint;
      return `0x${String(writes.length).padStart(64, "0")}` as `0x${string}`;
    },
    sendTransaction: async () => "0x01" as `0x${string}`,
  };
  return { deps, writes, simulations };
}

describe("orderRunner — prepareOrder (never signs)", () => {
  it("refuses an order on another chain than the wallet's", async () => {
    const { deps, writes } = fakeDeps({}, 8453);
    const res = await prepareOrder(deps, supply());
    expect(res).toMatchObject({ ok: false, state: "WRONG_CHAIN" });
    expect(writes).toHaveLength(0);
  });

  it("refuses when the live balance is below the amount", async () => {
    const { deps, writes } = fakeDeps({ balance: AMOUNT - 1n });
    const res = await prepareOrder(deps, supply());
    expect(res).toMatchObject({ ok: false, state: "INSUFFICIENT_BALANCE" });
    if (!res.ok) expect(res.message).toBe("Insufficient balance: this order needs 1000 USDC on Ethereum, your wallet holds 999.999999.");
    expect(writes).toHaveLength(0);
  });

  it("refuses when the simulation reverts", async () => {
    const { deps, writes } = fakeDeps({ allowance: AMOUNT, failSimulation: (fn) => fn === "supply" });
    const res = await prepareOrder(deps, supply());
    expect(res).toMatchObject({ ok: false, state: "SIMULATION_FAILED" });
    expect(writes).toHaveLength(0);
  });

  it("skips the approval when the live allowance already covers the amount", async () => {
    const { deps, simulations } = fakeDeps({ allowance: AMOUNT });
    const res = await prepareOrder(deps, supply());
    expect(res).toMatchObject({ ok: true, needsApproval: false });
    expect(simulations).toEqual(["supply"]);
  });
});

describe("orderRunner — executePreparedOrder", () => {
  it("sends only the order when no approval is needed", async () => {
    const { deps, writes } = fakeDeps({ allowance: AMOUNT });
    const prepared = await prepareOrder(deps, supply());
    if (!prepared.ok) throw new Error(prepared.message);
    const res = await executePreparedOrder(deps, prepared);
    expect(res.ok).toBe(true);
    expect(writes.map((w) => w.functionName)).toEqual(["supply"]);
  });

  it("approves exactly the amount, re-simulates after it mines, then sends", async () => {
    const { deps, writes, simulations } = fakeDeps({ allowance: 0n });
    const prepared = await prepareOrder(deps, supply());
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.needsApproval).toBe(true);
    const res = await executePreparedOrder(deps, prepared);
    expect(res.ok).toBe(true);
    expect(writes.map((w) => w.functionName)).toEqual(["approve", "supply"]);
    expect(writes[0].args[1]).toBe(AMOUNT);
    expect(simulations).toEqual(["approve", "supply"]);
  });

  it("resets a non-zero USDT allowance to 0 before approving", async () => {
    const { deps, writes } = fakeDeps({ allowance: 1n });
    const prepared = await prepareOrder(deps, supply(USDT));
    if (!prepared.ok) throw new Error(prepared.message);
    const res = await executePreparedOrder(deps, prepared);
    expect(res.ok).toBe(true);
    expect(writes.map((w) => [w.functionName, w.args[1]])).toEqual([
      ["approve", 0n],
      ["approve", AMOUNT],
      ["supply", AMOUNT],
    ]);
  });

  it("reports a reverted transaction", async () => {
    const { deps } = fakeDeps({ allowance: AMOUNT, receiptStatus: "reverted" });
    const prepared = await prepareOrder(deps, supply());
    if (!prepared.ok) throw new Error(prepared.message);
    const res = await executePreparedOrder(deps, prepared);
    expect(res).toMatchObject({ ok: false, state: "TRANSACTION_REVERTED" });
  });

  it("refuses to sign if the wallet switched chain after preparing", async () => {
    const { deps, writes } = fakeDeps({ allowance: AMOUNT });
    const prepared = await prepareOrder(deps, supply());
    if (!prepared.ok) throw new Error(prepared.message);
    const res = await executePreparedOrder({ ...deps, connectedChainId: 8453 }, prepared);
    expect(res).toMatchObject({ ok: false, state: "WRONG_CHAIN" });
    expect(writes).toHaveLength(0);
  });
});
