import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { extendedQuote, hlQuote } from "@/lib/planner/markets";
import { resetChartCache } from "@/lib/planner/marketCharts";

// The route end to end on the owner's SPCX conversation (2026-10-16), with the live data and the model mocked.
vi.mock("@/lib/features", () => ({ FEATURES: { perps: true } }));

const markets = {
  fetchedAt: new Date().toISOString(),
  quotes: [
    hlQuote({ market: "xyz:SPCX", base: "SPCX", markUsd: 145.965, fundingHourly: 0.096 / 8760, szDecimals: 2, maxLeverage: 20, dayVolumeUsd: 3e7 }),
    extendedQuote({ market: "SPCX-USD", base: "SPCX", markUsd: 145.965, fundingHourly: 0.149 / 8760, sizeStep: 0.01, minQty: 0.1, maxLeverage: 20, dayVolumeUsd: 1e6 }),
    hlQuote({ market: "ETH", base: "ETH", markUsd: 3000, fundingHourly: 0.0000125, szDecimals: 4, maxLeverage: 25, dayVolumeUsd: 1e9 }),
    extendedQuote({ market: "ETH-USD", base: "ETH", markUsd: 3001, fundingHourly: 0.00001, sizeStep: 0.001, minQty: 0.01, maxLeverage: 50, dayVolumeUsd: 5e8 }),
  ],
};
const portfolio = {
  netUsd: 53,
  assets: [
    { symbol: "USDC", venue: "Wallet", chain: "Base", balance: 10, usd: 10 },
    { symbol: "USDC", venue: "Hyperliquid Perps", chain: "Arbitrum", balance: 21.79, usd: 21.79 },
  ],
  lendingPositions: [],
  perps: [],
  netDeltaEthTotal: null,
  hyperliquid: { unified: true, collateralUsd: 21.79, marginUsedUsd: 0, freeMarginUsd: 21.79, spotUsdcUsd: 21.79 },
  extended: { connected: true, network: "mainnet", equityUsd: 21.35, availableUsd: 21.35 },
};

let modelCalls: string[] = [];
beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test";
  modelCalls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/yield-context")) return new Response(JSON.stringify({ summary: "live data", markets }));
    if (String(url).includes("openrouter")) {
      const body = JSON.parse(String(init?.body));
      modelCalls.push(body.messages[0].content.slice(0, 40));
      // The explain pass fails: the deterministic texts are used.
      return new Response("down", { status: 503 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

const post = async (body: Record<string, unknown>) => {
  const { POST } = await import("./route");
  const res = await POST(new NextRequest("http://localhost/api/parse-intent", { method: "POST", body: JSON.stringify({ portfolio, ...body }) }));
  return { status: res.status, data: await res.json() };
};

describe("POST /api/parse-intent — the owner's SPCX conversation", () => {
  it("1. 'beta neutral en SPCX leverage 10': asks the share of capital first, in English, without calling the model", async () => {
    const { data } = await post({ thesis: "beta neutral en SPCX leverage 10" });
    expect(data.decision).toBe("clarify");
    expect(data.clarify.question).toBe("How much of your available capital should this use?");
    expect(JSON.stringify(data)).not.toMatch(/capital disponible|Quelle part/);
    expect(modelCalls).toEqual([]);
  });

  it("2. answered 100%: two legs, long Hyperliquid / short Extended, 10x, sized on the free margin, executable — no model proposal", async () => {
    const { status, data } = await post({
      thesis: "beta neutral en SPCX leverage 10 — 100% of my available capital",
      clarified: true,
      answeredQuestion: "How much of your available capital should this use?",
    });
    expect(status).toBe(200);
    const s = data.strategies[0];
    expect(s.legs.map((l: { side: string; asset: string; protocol: string; leverage: number }) => `${l.side} ${l.asset} ${l.protocol} ${l.leverage}x`)).toEqual([
      // The thinner market's leg is sent first (execution policy).
      "Short SPCX-USD PERP Extended 10x",
      "Long xyz:SPCX PERP Hyperliquid 10x",
    ]);
    expect(s.status).toBe("executable");
    expect(s.economics.legs.map((l: { baseQuantity: number }) => l.baseQuantity)).toEqual([1.35, 1.35]);
    expect(data.recommended).toBe(0);
    // Only the explain pass reached the model.
    expect(modelCalls).toHaveLength(1);
  });

  it("3. the follow-up 'Why not open a long on Hyperliquid and a short on Extended?' — 100%: still SPCX, never 'HYPERLIQUID' or another asset", async () => {
    const { data } = await post({
      thesis: "Why not open a long on Hyperliquid and a short on Extended? — 100% of my available capital",
      clarified: true,
      answeredQuestion: "How much of your available capital should this use?",
      history: [{ request: "beta neutral en SPCX leverage 10", answer: "Proposed: Short SPCX-USD PERP on Extended 10x; Long xyz:SPCX PERP on Hyperliquid 10x" }],
    });
    const assets = data.strategies.flatMap((s: { legs: { asset: string }[] }) => s.legs.map((l) => l.asset));
    expect(assets).toEqual(["SPCX-USD PERP", "xyz:SPCX PERP"]);
    expect(data.strategies[0].status).toBe("executable");
  });

  it("4. 'beta neutral entre Hyperliquid et Extended' (no asset): asks which one, among assets both list", async () => {
    const { data } = await post({ thesis: "beta neutral entre Hyperliquid et Extended" });
    expect(data.clarify.question).toBe("Which asset should the neutral position use?");
    expect(data.clarify.options[0]).toMatch(/^SPCX/);
  });
});

describe("POST /api/parse-intent — a question answered in words", () => {
  const answerJson: { understanding: string; answer: Record<string, unknown> } = {
    understanding: "Your read of the crypto market today.",
    answer: {
      headline: "Mixed: BTC holds while ETH lags.",
      points: ["BTC $104,250, +1.1% over 24h", "ETH $3,012, -2.1% over 24h"],
      takeaway: "No strong trend: yields beat chasing price right now.",
      followUps: ["Best yield for my USDC, no lock-up"],
    },
  };
  let systems: string[] = [];
  let userMessages: string[] = [];
  beforeEach(() => {
    resetChartCache();
    systems = [];
    userMessages = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/yield-context")) return new Response(JSON.stringify({ summary: "live data", markets }));
      if (u.includes("/api/prices")) return new Response(JSON.stringify([{ symbol: "BTC", price: 104250, change24h: 1.05 }, { symbol: "ETH", price: 3012, change24h: -2.1 }, { symbol: "SOL", price: 180, change24h: 0.4 }]));
      if (u.includes("/api/news")) return new Response(JSON.stringify({ status: "ok", items: [{ id: "1", title: "ETF inflows rise", link: "", source: "Reuters", coins: ["BTC"] }] }));
      if (u.includes("/v2/chains")) return new Response(JSON.stringify([{ name: "Ethereum", tvl: 60e9 }, { name: "Solana", tvl: 10e9 }, { name: "Base", tvl: 5e9 }]));
      if (u.includes("llama.fi")) return new Response("down", { status: 503 });
      if (u.includes("openrouter")) {
        const body = JSON.parse(String(init?.body));
        systems.push(body.messages[0].content);
        userMessages.push(body.messages[1].content);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answerJson) } }] }));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  it("the owner's 'What to to think about the crypto market?': a market read from live prices and news — no capital question, no plan, no fallback", async () => {
    const { status, data } = await post({ thesis: "What to to think about the crypto market? — Market overview only, no plan and no trade" });
    expect(status).toBe(200);
    expect(data.decision).toBe("answer");
    expect(data.strategies).toEqual([]);
    expect(data.answer.headline).toBe("Mixed: BTC holds while ETH lags.");
    expect(data.answer.followUps).toEqual(["Best yield for my USDC, no lock-up"]);
    expect(systems).toHaveLength(1);
    expect(systems[0]).toMatch(/market analyst/);
    expect(userMessages[0]).toContain("BTC $104,250");
    expect(userMessages[0]).toContain("ETF inflows rise");
    // No chart picked by the model: today's price moves (CoinGecko) by default; the DeFi TVL source was down, so it's left out.
    expect(data.answer.charts.map((c: { id: string }) => c.id)).toEqual(["price_moves"]);
    expect(userMessages[0]).toContain("chain_tvl: TVL by chain · today: Ethereum $60.0B");
  });

  it("a macro question gets the charts the model picked, with the figures it read", async () => {
    answerJson.answer = { ...answerJson.answer, charts: ["chain_tvl", "made_up"] };
    const { data } = await post({ thesis: "What's the macro picture for DeFi TVL?" });
    expect(data.decision).toBe("answer");
    expect(data.answer.charts.map((c: { id: string }) => c.id)).toEqual(["chain_tvl"]);
    expect(data.answer.charts[0].points[0]).toEqual({ label: "Ethereum", value: 60e9 });
  });

  it("a malformed answer is an error the client reports, not an invented plan", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("openrouter")) return new Response(JSON.stringify({ choices: [{ message: { content: "{\"answer\": {\"headline\": \"x\"}}" } }] }));
      return new Response(JSON.stringify(u.includes("/api/news") ? { items: [] } : u.includes("/api/prices") ? [] : { summary: "" }));
    });
    const { status, data } = await post({ thesis: "How is the market doing?" });
    expect(status).toBe(500);
    expect(data.error).toMatch(/malformed/);
  });

  it("the model may answer a question in words on its own ('explain funding rates')", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("/api/yield-context")) return new Response(JSON.stringify({ summary: "live data", markets }));
      if (u.includes("openrouter")) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "answer", strategies: [], ...answerJson }) } }] }));
      throw new Error(`unexpected fetch ${url}`);
    });
    const { status, data } = await post({ thesis: "Explain funding rates", portfolio: undefined });
    expect(status).toBe(200);
    expect(data.decision).toBe("answer");
    expect(data.answer.points).toHaveLength(2);
  });
});
