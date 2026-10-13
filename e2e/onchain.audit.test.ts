/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// @ts-nocheck — report-only script, loose ABI result typing
import { createPublicClient, http, parseAbi } from "viem";
/**
 * On-chain sanity audit of every address Meridian signs against (report only).
 * Run: `npm run audit:onchain` (needs outbound RPC access). Prints a table of
 * OK / FAIL / FROZEN / NOT-LISTED / CAP-FULL per chain and contract.
 */
import { it } from "vitest";
import { writeFileSync } from "node:fs";
import * as onchain from "@/lib/onchain";
import * as uni from "@/lib/integrations/uniswap";
import * as allow from "@/lib/mcp/routerAllowlist";
import * as pendle from "@/lib/integrations/pendle";
import * as eigen from "@/lib/integrations/eigenlayer";

const rpc: Record<string, string> = {};
for (const c of onchain.SUPPORTED_CHAINS) rpc[c.id] = c.rpcUrls.default.http[0];
const A: any = {
  rpc, labels: onchain.CHAIN_LABEL, aave: onchain.AAVE_V3_POOL_BY_CHAIN, spark: onchain.SPARK_POOL_BY_CHAIN,
  comet: onchain.COMPOUND_V3_USDC_COMET_BY_CHAIN, uniRouter: uni.UNISWAP_SWAP_ROUTER02_BY_CHAIN, uniQuoter: uni.UNISWAP_QUOTER_V2_BY_CHAIN,
  lifi: allow.LIFI_DIAMOND_BY_CHAIN, debridge: allow.DEBRIDGE_DLN_SOURCE_BY_CHAIN, tokens: onchain.TRACKED_TOKENS_BY_CHAIN, steth: onchain.STETH_ADDRESS,
};
const out: any[] = [];
const log = (chain, kind, target, status, detail = "") => out.push({ chain: A.labels[chain] ?? chain, kind, target, status, detail });
const ERC20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function totalSupply() view returns (uint256)"]);
const POOL = parseAbi(["function getConfiguration(address) view returns (uint256)", "function getReserveData(address) view returns ((uint256 configuration),uint128,uint128,uint128,uint128,uint128,uint40,uint16,address aToken,address,address,address,uint128,uint128,uint128)", "function getReservesList() view returns (address[])"]);
const COMET = parseAbi(["function baseToken() view returns (address)", "function isSupplyPaused() view returns (bool)", "function isWithdrawPaused() view returns (bool)"]);
const UNI = parseAbi(["function factory() view returns (address)", "function WETH9() view returns (address)"]);
const QUOTER = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"]);
const LIDO = parseAbi(["function isStakingPaused() view returns (bool)"]);
const bit = (v, i) => (v >> BigInt(i)) & 1n;
const bits = (v, s, n) => (v >> BigInt(s)) & ((1n << BigInt(n)) - 1n);

async function chainProbe(idStr) {
  const id = Number(idStr);
  const c = createPublicClient({ transport: http(A.rpc[idStr], { timeout: 20000, retryCount: 2 }) });
  try { const got = await c.getChainId(); if (got !== id) return log(id, "rpc", A.rpc[idStr], "FAIL", `chainId ${got}`); }
  catch (e) { return log(id, "rpc", A.rpc[idStr], "FAIL", e.shortMessage ?? String(e).slice(0, 120)); }
  const code = async (a) => { try { const x = await c.getCode({ address: a }); return x && x !== "0x"; } catch { return null; } };
  const tokens = A.tokens[idStr] ?? [];
  for (const t of tokens) {
    if (!(await code(t.address))) { log(id, "token", `${t.symbol} ${t.address}`, "FAIL", "no code"); continue; }
    try { const d = await c.readContract({ address: t.address, abi: ERC20, functionName: "decimals" }); const s = await c.readContract({ address: t.address, abi: ERC20, functionName: "symbol" }).catch(() => "?");
      log(id, "token", `${t.symbol} ${t.address}`, d === t.decimals ? "OK" : "FAIL", `onchain symbol=${s} decimals=${d} configured=${t.decimals}`); }
    catch (e) { log(id, "token", `${t.symbol} ${t.address}`, "FAIL", e.shortMessage ?? "decimals() reverted"); }
  }
  const pools = [["Aave", A.aave[idStr]], ["Spark", A.spark[idStr]]].filter((p) => p[1]);
  for (const [name, pool] of pools) {
    if (!(await code(pool))) { log(id, name, pool, "FAIL", "no code"); continue; }
    let listed = [];
    try { listed = (await c.readContract({ address: pool, abi: POOL, functionName: "getReservesList" })).map((x) => x.toLowerCase()); } catch (e) { log(id, name, pool, "FAIL", "getReservesList reverted"); continue; }
    log(id, name, pool, "OK", `${listed.length} reserves`);
    for (const t of tokens) {
      if (!listed.includes(t.address.toLowerCase())) { log(id, `${name}-reserve`, t.symbol, "NOT-LISTED"); continue; }
      const cfg = await c.readContract({ address: pool, abi: POOL, functionName: "getConfiguration", args: [t.address] });
      const v = typeof cfg === "bigint" ? cfg : cfg.data ?? cfg;
      const active = bit(v, 56), frozen = bit(v, 57), borrow = bit(v, 58), paused = bit(v, 60), supplyCap = bits(v, 116, 36);
      let capInfo = "";
      if (supplyCap > 0n) { try { const rd = await c.readContract({ address: pool, abi: POOL, functionName: "getReserveData", args: [t.address] }); const ts = await c.readContract({ address: rd[8], abi: ERC20, functionName: "totalSupply" }); const used = Number(ts) / 10 ** t.decimals; capInfo = ` supplied=${Math.round(used)}/${supplyCap} (${((used / Number(supplyCap)) * 100).toFixed(1)}%)`; } catch { capInfo = " cap?"; } }
      const st = !active || paused ? "FAIL" : frozen ? "FROZEN" : capInfo && Number(capInfo.match(/\(([\d.]+)%/)?.[1]) > 99.5 ? "CAP-FULL" : "OK";
      log(id, `${name}-reserve`, t.symbol, st, `active=${active} frozen=${frozen} paused=${paused} borrowing=${borrow}${capInfo}`);
    }
  }
  const comet = A.comet[idStr];
  if (comet) {
    if (!(await code(comet))) log(id, "Compound", comet, "FAIL", "no code");
    else { try { const b = await c.readContract({ address: comet, abi: COMET, functionName: "baseToken" }); const usdc = tokens.find((t) => t.symbol === "USDC"); const sp = await c.readContract({ address: comet, abi: COMET, functionName: "isSupplyPaused" });
      log(id, "Compound", comet, usdc && b.toLowerCase() === usdc.address.toLowerCase() && !sp ? "OK" : "FAIL", `baseToken=${b} trackedUSDC=${usdc?.address} supplyPaused=${sp}`); } catch (e) { log(id, "Compound", comet, "FAIL", e.shortMessage ?? "reverted"); } }
  }
  const router = A.uniRouter[idStr], quoter = A.uniQuoter[idStr];
  if (router || quoter) {
    const rc = router ? await code(router) : false, qc = quoter ? await code(quoter) : false;
    let rf = null, qf = null;
    if (rc) rf = await c.readContract({ address: router, abi: UNI, functionName: "factory" }).catch(() => null);
    if (qc) qf = await c.readContract({ address: quoter, abi: UNI, functionName: "factory" }).catch(() => null);
    log(id, "Uniswap", `router ${router} quoter ${quoter}`, rc && qc && rf && qf && rf.toLowerCase() === qf.toLowerCase() ? "OK" : "FAIL", `routerCode=${rc} quoterCode=${qc} routerFactory=${rf} quoterFactory=${qf}`);
    const usdc = tokens.find((t) => t.symbol === "USDC"); const weth = tokens.find((t) => t.symbol === "WETH");
    if (qc && usdc && weth) for (const fee of [500, 3000]) {
      try { const r = await c.simulateContract({ address: quoter, abi: QUOTER, functionName: "quoteExactInputSingle", args: [{ tokenIn: usdc.address, tokenOut: weth.address, amountIn: 100n * 10n ** BigInt(usdc.decimals), fee, sqrtPriceLimitX96: 0n }] });
        log(id, "Uniswap-quote", `USDC→WETH fee ${fee}`, r.result[0] > 0n ? "OK" : "FAIL", `out=${Number(r.result[0]) / 1e18} WETH for 100 USDC`); }
      catch (e) { log(id, "Uniswap-quote", `USDC→WETH fee ${fee}`, "FAIL", (e.shortMessage ?? "reverted").slice(0, 100)); }
    }
  }
  for (const [name, m] of [["LI.FI", A.lifi], ["deBridge", A.debridge]]) if (m[idStr]) log(id, name, m[idStr], (await code(m[idStr])) ? "OK" : "FAIL", "");
  if (pendle.PENDLE_CHAINS.includes(id)) log(id, "Pendle", pendle.PENDLE_ROUTER_V4, (await code(pendle.PENDLE_ROUTER_V4)) ? "OK" : "FAIL", "RouterV4");
  if (id === 1) for (const [n, a] of [["StrategyManager", eigen.EIGENLAYER_STRATEGY_MANAGER], ["stETH strategy", eigen.EIGENLAYER_STETH_STRATEGY], ["DelegationManager", eigen.EIGENLAYER_DELEGATION_MANAGER]]) log(id, "EigenLayer", `${n} ${a}`, (await code(a)) ? "OK" : "FAIL", "");
  if (id === 1) { const p = await c.readContract({ address: A.steth, abi: LIDO, functionName: "isStakingPaused" }).catch(() => "?"); log(id, "Lido", A.steth, p === false ? "OK" : "FAIL", `stakingPaused=${p}`); }
}
it("on-chain address audit", async () => {
  await Promise.all(Object.keys(A.rpc).map((k) => chainProbe(k).catch((e) => log(Number(k), "probe", "-", "ERROR", String(e).slice(0, 150)))));
  out.sort((a, b) => (a.chain + a.kind).localeCompare(b.chain + b.kind));
  for (const r of out) console.log(`AUDIT | ${r.status.padEnd(10)} | ${String(r.chain).padEnd(10)} | ${r.kind.padEnd(14)} | ${r.target} | ${r.detail}`);
  if (process.env.AUDIT_OUT) writeFileSync(process.env.AUDIT_OUT, JSON.stringify(out, null, 1));
}, 600_000);
