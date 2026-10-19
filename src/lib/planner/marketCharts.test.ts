import { beforeEach, describe, expect, it } from "vitest";
import {
  chartsSection,
  cleanChart,
  fetchDefiCharts,
  fmtUsdShort,
  parseChainTvl,
  parseDexVolume,
  parseHistoricalTvl,
  parseStablecoinSupply,
  pickCharts,
  priceMovesChart,
  resetChartCache,
} from "@/lib/planner/marketCharts";

const NOW = Date.UTC(2026, 9, 19) / 1000;
const DAY = 86_400;
/** n daily points ending today, rising linearly from `start` by `step`. */
const daily = (n: number, start: number, step: number) => Array.from({ length: n }, (_, i) => ({ t: NOW - (n - 1 - i) * DAY, v: start + i * step }));

describe("DefiLlama parsers", () => {
  it("total DeFi TVL: the last 90 days, with the latest value and its 7d and 90d change", () => {
    const body = daily(120, 100e9, 0.5e9).map((p) => ({ date: p.t, tvl: p.v }));
    const c = parseHistoricalTvl(body, NOW)!;
    expect(c.kind).toBe("line");
    expect(c.points).toHaveLength(91);
    expect(c.points.at(-1)).toEqual({ label: "2026-10-19", value: 159.5e9 });
    expect(c.caption).toBe("$159.5B · +2.2% 7d · +39.3% 90d");
  });

  it("stablecoin supply sums every peg (USD, EUR…) and reads string dates", () => {
    const body = daily(30, 250e9, 1e9).map((p) => ({ date: String(p.t), totalCirculatingUSD: { peggedUSD: p.v, peggedEUR: 1e9 } }));
    const c = parseStablecoinSupply(body, NOW)!;
    expect(c.points.at(-1)!.value).toBe(280e9);
  });

  it("TVL by chain: the top 8, largest first, with the leader's share", () => {
    const body = [
      { name: "Ethereum", tvl: 60e9 },
      { name: "Solana", tvl: 10e9 },
      { name: "Base", tvl: 5e9 },
      { name: "Dead", tvl: 0 },
      ...Array.from({ length: 10 }, (_, i) => ({ name: `C${i}`, tvl: 1e9 - i })),
    ];
    const c = parseChainTvl(body)!;
    expect(c.points.map((p) => p.label).slice(0, 3)).toEqual(["Ethereum", "Solana", "Base"]);
    expect(c.points).toHaveLength(8);
    expect(c.caption).toBe("Ethereum holds 71% of $85.0B");
  });

  it("DEX volume: 30 days, last day against the average", () => {
    const body = { totalDataChart: daily(40, 5e9, 0).map((p, i, a) => [p.t, i === a.length - 1 ? 6e9 : p.v]) };
    const c = parseDexVolume(body, NOW)!;
    expect(c.points).toHaveLength(31);
    expect(c.caption).toBe("$6.0B last day · +20.0% vs the 30-day average");
  });

  it("a shape drift gives no chart rather than a wrong one", () => {
    expect(parseHistoricalTvl({ error: "rate limited" }, NOW)).toBeNull();
    expect(parseStablecoinSupply([], NOW)).toBeNull();
    expect(parseChainTvl([{ name: "x" }])).toBeNull();
    expect(parseDexVolume({ totalDataChart: "n/a" }, NOW)).toBeNull();
  });
});

describe("price moves", () => {
  it("majors and the biggest movers, best to worst, never stablecoins", () => {
    const c = priceMovesChart([
      { symbol: "BTC", price: 1, change24h: 1.04 },
      { symbol: "ETH", price: 1, change24h: -2.16 },
      { symbol: "USDC", price: 1, change24h: 0.01 },
      { symbol: "PEPE", price: 1, change24h: 12.3 },
      { symbol: "LINK", price: 1, change24h: -0.2 },
    ])!;
    expect(c.kind).toBe("diverging");
    expect(c.points).toEqual([
      { label: "PEPE", value: 12.3 },
      { label: "BTC", value: 1 },
      { label: "LINK", value: -0.2 },
      { label: "ETH", value: -2.2 },
    ]);
    expect(c.caption).toBe("2 of 4 tracked coins up");
  });
});

describe("pickCharts / chartsSection / cleanChart", () => {
  const moves = priceMovesChart([{ symbol: "BTC", price: 1, change24h: 1 }, { symbol: "ETH", price: 1, change24h: -1 }, { symbol: "SOL", price: 1, change24h: 2 }])!;
  const tvl = parseHistoricalTvl(daily(20, 1e9, 1e7).map((p) => ({ date: p.t, tvl: p.v })), NOW)!;
  const chains = parseChainTvl([{ name: "Ethereum", tvl: 3e9 }, { name: "Base", tvl: 2e9 }, { name: "Arbitrum", tvl: 1e9 }])!;

  it("keeps the model's picks that exist, in order, up to 3; else price moves + TVL", () => {
    expect(pickCharts(["chain_tvl", "nope", "defi_tvl", "chain_tvl"], [moves, tvl, chains]).map((c) => c.id)).toEqual(["chain_tvl", "defi_tvl"]);
    expect(pickCharts(undefined, [moves, tvl, chains]).map((c) => c.id)).toEqual(["price_moves", "defi_tvl"]);
    expect(pickCharts(["stablecoins"], [chains]).map((c) => c.id)).toEqual([]);
  });

  it("tells the model the same figures the charts show, or that they're unavailable", () => {
    const s = chartsSection([tvl, chains]);
    expect(s).toContain("defi_tvl: Total DeFi TVL · 90 days: $1.2B");
    expect(s).toContain("chain_tvl: TVL by chain · today: Ethereum $3.0B, Base $2.0B, Arbitrum $1.0B");
    expect(chartsSection([])).toMatch(/unavailable/);
  });

  it("cleanChart drops malformed charts", () => {
    expect(cleanChart(chains)).toEqual(chains);
    expect(cleanChart({ ...chains, id: "made_up" })).toBeNull();
    expect(cleanChart({ ...chains, points: [{ label: "a", value: 1 }] })).toBeNull();
    expect(fmtUsdShort(-1.5e12)).toBe("-$1.50T");
  });
});

describe("fetchDefiCharts", () => {
  beforeEach(() => resetChartCache());
  it("reads the four DefiLlama sources, leaves out the ones that fail, and caches the result", async () => {
    let calls = 0;
    const fake = (async (url: string) => {
      calls++;
      if (url.includes("historicalChainTvl")) return new Response(JSON.stringify(daily(20, 1e9, 1e7).map((p) => ({ date: p.t, tvl: p.v }))));
      if (url.includes("/v2/chains")) return new Response(JSON.stringify([{ name: "Ethereum", tvl: 3e9 }, { name: "Base", tvl: 2e9 }, { name: "Arbitrum", tvl: 1e9 }]));
      return new Response("down", { status: 503 });
    }) as unknown as typeof fetch;
    const charts = await fetchDefiCharts(fake, NOW * 1000);
    expect(charts.map((c) => c.id)).toEqual(["defi_tvl", "chain_tvl"]);
    await fetchDefiCharts(fake, NOW * 1000 + 60_000);
    expect(calls).toBe(4);
  });
});
