import { describe, expect, it } from "vitest";
import { enforceConformance, namedVenues, recomputeEconomics, type ConformanceContext } from "./schema";
import { extendedQuote, hlQuote, type MarketSnapshot } from "./markets";
import type { VenueBalances } from "./economics";
import { enforceExplicitOrder, parseExplicitPerpOrder } from "@/lib/explicitOrder";
import type { LLMStrategy } from "@/lib/strategyIntegrity";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const markets: MarketSnapshot = {
  fetchedAt: new Date(NOW - 30_000).toISOString(),
  quotes: [
    // +0.00125%/h = +10.95%/yr: longs pay shorts.
    hlQuote({ market: "ETH", base: "ETH", markUsd: 3000, fundingHourly: 0.0000125, szDecimals: 4, maxLeverage: 25, dayVolumeUsd: 1e9 }),
    hlQuote({ market: "UETH", base: "ETH", markUsd: 3000, fundingHourly: 0, szDecimals: 4, maxLeverage: 1, dayVolumeUsd: 1e7, kind: "spot" }),
    hlQuote({ market: "xyz:AMD", base: "AMD", markUsd: 160, fundingHourly: 0.00001, szDecimals: 3, maxLeverage: 10, dayVolumeUsd: 2e7 }),
    // +0.001%/h = +8.76%/yr.
    extendedQuote({ market: "ETH-USD", base: "ETH", markUsd: 3001, fundingHourly: 0.00001, sizeStep: 0.001, minQty: 0.01, maxLeverage: 50, dayVolumeUsd: 5e8 }),
    extendedQuote({ market: "AMD_24_5-USD", base: "AMD", markUsd: 160.2, fundingHourly: 0.00002, sizeStep: 0.1, minQty: 0.1, maxLeverage: 10, dayVolumeUsd: 1e6 }),
  ],
};

/** Balances as the server sees them. Extended "0, status ok" and "unknown" are different inputs. */
const funded: VenueBalances = { hyperliquidFreeUsd: 200, extendedFreeUsd: 200, walletDeployableUsd: 0 };
const extendedEmpty = { connected: true, network: "mainnet", availableUsd: 0 };
const extendedUnknown = { connected: true, network: "mainnet" };
const extendedFunded = { connected: true, network: "mainnet", availableUsd: 200 };

const ctx = (over: Partial<ConformanceContext> = {}): ConformanceContext => ({
  order: null,
  namedVenues: [],
  extended: extendedFunded,
  markets,
  balances: funded,
  now: NOW,
  ...over,
});

const strat = (name: string, legs: LLMStrategy["legs"], extra: Partial<LLMStrategy> & Record<string, unknown> = {}): LLMStrategy =>
  ({ name, risk: "moderate", variantNote: "", summary: "", legs, ...extra }) as LLMStrategy;
const hlEthNeutral = (lev: number) =>
  strat(`Hyperliquid ETH Neutral (${lev}x)`, [
    { side: "Buy", asset: "UETH", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 30 },
    { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 30, leverage: lev },
  ]);
const pair = (size = 60) =>
  strat("ETH pair Extended / Hyperliquid", [
    { side: "Long", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: size, leverage: 1 },
    { side: "Short", asset: "ETH-USD PERP", protocol: "Extended", chain: "Arbitrum", sizeUsd: size, leverage: 1 },
  ]);
const aave = (name: string, carry: number) =>
  strat(name, [{ side: "Supply", asset: "USDC", protocol: "Aave", chain: "Base", sizeUsd: 1000 }], {
    economics: { capitalCommittedUsd: 1000, annualizedGrossCarryUsd: carry, entryExitCostUsd: 0, holdingDays: 365 },
  });

// Reference cases of STRATEGIST.md section 9.
describe("planner contract — reference cases", () => {
  it("volume between Extended and Hyperliquid, Extended balance 0 (status ok): the pair is requested and blocked; Hyperliquid-only plans are labeled alternatives", () => {
    const thesis = "ouvre du beta neutral pour optimiser le volume entre Extended et Hyperliquid";
    expect(namedVenues(thesis)).toEqual(["Hyperliquid", "Extended"]);
    const out = enforceConformance([hlEthNeutral(1), hlEthNeutral(2), pair()], "farming", {
      ...ctx({ namedVenues: namedVenues(thesis), extended: extendedEmpty, balances: { ...funded, extendedFreeUsd: 0 } }),
    });
    expect(out.strategies.map((s) => [s.name, s.kind, s.status])).toEqual([
      ["ETH pair Extended / Hyperliquid", "requested", "blocked"],
      ["Hyperliquid ETH Neutral (1x)", "alternative", "executable"],
      ["Hyperliquid ETH Neutral (2x)", "alternative", "executable"],
    ]);
    expect(out.strategies[0].blockers?.[0]).toMatch(/Extended has \$0 free/);
    expect(out.strategies[1].changes).toEqual(["venue: Extended not used (you named it)"]);
    // Never an alternative.
    expect(out.recommended).toBe(0);
  });

  it("Extended balance unknown blocks Extended legs: unknown is neither zero nor usable", () => {
    const out = enforceConformance([pair()], "farming", ctx({ extended: extendedUnknown, balances: { ...funded, extendedFreeUsd: null } }));
    expect(out.strategies[0].status).toBe("blocked");
    expect(out.strategies[0].blockers?.[0]).toMatch(/balance unknown/);
    expect(out.strategies[0].economics?.capitalToAddUsd).toBeNull();
  });

  it("a deposit leg from Arbitrum USDC funds the Extended margin: the pair becomes executable", () => {
    const withDeposit = strat("ETH pair with Extended deposit", [{ side: "Deposit", asset: "USDC", protocol: "Extended", chain: "Arbitrum", sizeUsd: 65 }, ...pair().legs]);
    const empty = { ...funded, extendedFreeUsd: 0, walletDeployableUsd: 100 };
    const ok = enforceConformance([withDeposit], "farming", ctx({ extended: extendedEmpty, balances: empty })).strategies[0];
    expect(ok.status).toBe("executable");
    expect(ok.economics?.capitalToAddUsd).toBe(0);
    // The wallet can't fund the deposit: blocked, saying so.
    const poor = enforceConformance([withDeposit], "farming", ctx({ extended: extendedEmpty, balances: { ...empty, walletDeployableUsd: 20 } })).strategies[0];
    expect(poor.status).toBe("blocked");
    expect(poor.blockers?.[0]).toMatch(/deposit to Extended needs \$65/);
  });

  it("only Hyperliquid plans for a two-venue request: no recommendation", () => {
    const out = enforceConformance([hlEthNeutral(1)], "farming", ctx({ namedVenues: ["Hyperliquid", "Extended"], extended: { connected: false } }));
    expect(out.strategies[0].kind).toBe("alternative");
    expect(out.recommended).toBeUndefined();
  });

  it("short AMD on Extended, Extended balance 0: requested plan blocked with null figures, the Hyperliquid short as a labeled alternative", () => {
    const thesis = "open short amd sur extended";
    const order = parseExplicitPerpOrder(thesis);
    const llm = [strat("Short AMD on Hyperliquid", [{ side: "Short", asset: "xyz:AMD PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 66, leverage: 5 }])];
    const withOrder = enforceExplicitOrder(llm, order, [], 0);
    const out = enforceConformance(withOrder, "explicit_order", ctx({ order, namedVenues: namedVenues(thesis), extended: extendedEmpty, balances: { ...funded, extendedFreeUsd: 0 } }));
    expect(out.strategies.map((s) => [s.kind, s.status, s.legs[0].protocol])).toEqual([
      ["requested", "blocked", "Extended"],
      ["alternative", "executable", "Hyperliquid"],
    ]);
    // No size was invented for the blocked plan.
    expect(out.strategies[0].economics?.legs?.[0].baseQuantity).toBeNull();
    expect(out.strategies[0].economics?.annualizedReturnOnCapitalPct).toBeNull();
    expect(out.strategies[1].changes).toContain("venue: Extended → Hyperliquid");
    expect(out.recommended).toBe(0);
  });

  it("short ETH 2x SL 20%: a leverage variant is an alternative, never a requested plan", () => {
    const order = parseExplicitPerpOrder("short ETH levier 2, SL 20%");
    const exact = strat("Short ETH 2x", [{ side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 100, leverage: 2, stopLossPct: 20 }]);
    const variant = strat("Short ETH 3x", [{ side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 100, leverage: 3, stopLossPct: 20 }]);
    const out = enforceConformance([variant, exact], "explicit_order", ctx({ order }));
    expect(out.strategies[0]).toMatchObject({ name: "Short ETH 2x", kind: "requested", status: "executable" });
    expect(out.strategies[1]).toMatchObject({ name: "Short ETH 3x", kind: "alternative", changes: ["leverage: 2x → 3x"] });
    expect(out.recommended).toBe(0);
  });

  it("a blocked alternative is dropped (Hyperliquid margin unknown)", () => {
    const out = enforceConformance([pair(), hlEthNeutral(1)], "farming", ctx({ namedVenues: ["Hyperliquid", "Extended"], balances: { ...funded, hyperliquidFreeUsd: null } }));
    expect(out.strategies.map((s) => s.name)).toEqual(["ETH pair Extended / Hyperliquid"]);
    expect(out.strategies[0].status).toBe("blocked");
  });

  it("venue plans without market data are blocked, never priced from the model's numbers", () => {
    const out = enforceConformance([pair()], "farming", ctx({ markets: undefined }));
    expect(out.strategies[0].status).toBe("blocked");
    expect(out.strategies[0].economics).toBeUndefined();
  });
});

describe("planner contract — per-leg economics", () => {
  const out = enforceConformance([pair()], "farming", ctx());
  const s = out.strategies[0];
  const e = s.economics!;

  it("puts the lower-volume leg first and attaches the execution policy", () => {
    // Extended ETH-USD trades $500M a day, Hyperliquid ETH $1B.
    expect(s.legs.map((l) => l.protocol)).toEqual(["Extended", "Hyperliquid"]);
    expect(s.pair).toEqual({ legs: [1, 0], sizing: "equal_base_quantity" });
    expect(s.execution).toMatchObject({ sequence: [0, 1], maxUnhedgedSeconds: 120, secondLegSizing: "first_leg_filled_quantity" });
    expect(s.execution?.maxSlippagePct[0]).toBe(1);
  });

  it("one base quantity valid on both markets (common step of 0.0001 and 0.001)", () => {
    // min(60/3000, 60/3001) = 0.01999… → 0.019 on the 0.001 step.
    expect(e.legs!.map((l) => l.baseQuantity)).toEqual([0.019, 0.019]);
    expect(e.legs!.map((l) => l.referencePriceUsd)).toEqual([3001, 3000]);
    expect(s.status).toBe("executable");
  });

  it("carry is signed per leg (short earns funding, long pays it) and the total is their sum", () => {
    const [short, long] = e.legs!;
    expect(short.side).toBe("short");
    expect(short.legCarryAnnualPct).toBeCloseTo(8.76, 6);
    expect(long.legCarryAnnualPct).toBeCloseTo(-10.95, 6);
    expect(e.annualizedGrossCarryUsd).toBeCloseTo(short.annualizedCarryUsd! + long.annualizedCarryUsd!, 2);
    expect(e.annualizedGrossCarryUsd!).toBeLessThan(0);
  });

  it("returns a percent (×100) with the one formula", () => {
    const expected = (100 * (e.annualizedGrossCarryUsd! - e.entryExitCostUsd! * (365 / e.holdingDays))) / e.capitalCommittedUsd!;
    expect(e.annualizedReturnOnCapitalPct).toBeCloseTo(expected, 1);
    expect(e.holdingDays).toBe(7);
    expect(e.volumeUsd).toBeCloseTo(2 * 0.019 * 3001 + 2 * 0.019 * 3000, 2);
  });

  it("counts capital once: a deposit leg moves money, it doesn't add capital", () => {
    const withDeposit = strat("ETH pair with deposit", [{ side: "Deposit", asset: "USDC", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 60 }, ...pair().legs]);
    const d = enforceConformance([withDeposit], "farming", ctx({ balances: { hyperliquidFreeUsd: 0, extendedFreeUsd: 200, walletDeployableUsd: 100 } })).strategies[0];
    expect(d.economics?.capitalCommittedUsd).toBe(e.capitalCommittedUsd);
    expect(d.economics?.capitalToAddUsd).toBe(0);
    expect(d.status).toBe("executable");
  });

  it("reports the capital still to bring when a venue is short", () => {
    const short = enforceConformance([pair()], "farming", ctx({ balances: { ...funded, hyperliquidFreeUsd: 20 } })).strategies[0];
    expect(short.economics?.capitalToAddUsd).toBeGreaterThan(30);
    expect(short.status).toBe("blocked");
  });

  it("flags quotes older than the price policy as stale (indicative only)", () => {
    const stale = enforceConformance([pair()], "farming", ctx({ now: NOW + 10 * 60_000 })).strategies[0];
    expect(stale.economics?.dataStatus).toBe("stale");
  });
});

describe("planner contract — non-venue economics and ranking", () => {
  it("recomputes the return as a percent, and null with a reason when it can't", () => {
    expect(recomputeEconomics({ capitalCommittedUsd: 1000, annualizedGrossCarryUsd: 50, entryExitCostUsd: 0, holdingDays: 365 }, 30)?.annualizedReturnOnCapitalPct).toBe(5);
    const zero = recomputeEconomics({ capitalCommittedUsd: 0, annualizedGrossCarryUsd: 5 }, 30)!;
    expect(zero.annualizedReturnOnCapitalPct).toBeNull();
    expect(zero.returnUnavailableReason).toMatch(/capital/);
    expect(recomputeEconomics({ capitalCommittedUsd: 50, annualizedGrossCarryUsd: 5 }, 30)?.holdingDays).toBe(30);
  });

  it("yield ranks requested plans by annualized return on capital", () => {
    const out = enforceConformance([aave("Low", 30), aave("High", 60)], "yield", ctx());
    expect(out.strategies.map((s) => s.name)).toEqual(["High", "Low"]);
    expect(out.strategies[0].economics?.annualizedReturnOnCapitalPct).toBe(6);
  });

  it("farming ranks by entry+exit cost per dollar of volume (spot taker fee is higher than perp)", () => {
    const perpPair = pair();
    const out = enforceConformance([hlEthNeutral(1), perpPair], "farming", ctx());
    expect(out.strategies[0].name).toBe("ETH pair Extended / Hyperliquid");
  });

  it("returns at most three plans, requested before alternatives", () => {
    const out = enforceConformance([hlEthNeutral(1), hlEthNeutral(2), hlEthNeutral(3), pair()], "farming", ctx({ namedVenues: ["Hyperliquid", "Extended"] }));
    expect(out.strategies).toHaveLength(3);
    expect(out.strategies[0].name).toBe("ETH pair Extended / Hyperliquid");
    expect(out.strategies[0].status).toBe("executable");
  });
});

describe("planner contract — the server sizes perp legs from the free margin (owner's SPCX test, 2026-10-16)", () => {
  const spcx: MarketSnapshot = {
    fetchedAt: markets.fetchedAt,
    quotes: [
      hlQuote({ market: "xyz:SPCX", base: "SPCX", markUsd: 146.4, fundingHourly: 0.0000153, szDecimals: 2, maxLeverage: 20, dayVolumeUsd: 3e7 }),
      extendedQuote({ market: "SPCX-USD", base: "SPCX", markUsd: 146.4, fundingHourly: 0.00002, sizeStep: 0.01, minQty: 0.1, maxLeverage: 20, dayVolumeUsd: 1e6 }),
    ],
  };
  const spcxPair = strat("SPCX Beta-Neutral", [
    { side: "Short", asset: "SPCX-USD PERP", protocol: "Extended", chain: "Arbitrum", sizeUsd: 10, leverage: 10 },
    { side: "Long", asset: "xyz:SPCX PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 10, leverage: 10 },
  ]);
  const balances: VenueBalances = { hyperliquidFreeUsd: 21.79, extendedFreeUsd: 21, walletDeployableUsd: 10 };
  const run = (share: number | undefined) =>
    enforceConformance([spcxPair], "farming", ctx({ markets: spcx, balances, extended: { connected: true, network: "mainnet", availableUsd: 21 }, namedVenues: ["Hyperliquid", "Extended"], sizeShare: share })).strategies[0];

  it("100% of the capital at 10x: two legs, ~$194 each, executable", () => {
    const s = run(1);
    expect(s.legs).toHaveLength(2);
    expect(s.status).toBe("executable");
    expect(s.economics?.legs?.map((l) => l.baseQuantity)).toEqual([1.32, 1.32]);
    expect(s.apy).toBeUndefined();
  });

  it("a share too small for the market minimum is blocked with the margin it needs", () => {
    const s = run(0.05);
    expect(s.status).toBe("blocked");
    expect(s.blockers?.join(" ")).toMatch(/under the market minimum \(0\.1 SPCX\); at 10x it needs about \$2\.51 free on Extended/);
  });

  it("without a share, the model's dollar size stands", () => {
    expect(run(undefined).economics?.legs?.map((l) => l.baseQuantity)).toEqual([0.06, 0.06]);
  });
});

describe("farming pair sized on the whole capital (owner report: 25% gave $4.80 legs, blocked under the minimums)", () => {
  // Hyperliquid $91.92 free, Extended empty, $23.87 USDC in the wallet; "25% of my available capital".
  const balances: VenueBalances = { hyperliquidFreeUsd: 91.92, extendedFreeUsd: 0, walletDeployableUsd: 23.87 };
  const ethPair = (lev: number) =>
    strat("ETH beta-neutral", [
      { side: "Long", asset: "ETH-USD PERP", protocol: "Extended", chain: "Arbitrum", leverage: lev },
      { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", leverage: lev },
    ]);

  it("funds Extended from the wallet and opens legs over both markets' minimums", async () => {
    const { addPairDeposits } = await import("./sizing");
    const funded = addPairDeposits(ethPair(3), balances);
    expect(funded.legs?.[0]).toMatchObject({ side: "Deposit", protocol: "Extended", asset: "USDC", sizeUsd: 23.87 });
    const out = enforceConformance([funded], "farming", ctx({ extended: extendedEmpty, balances, sizeShare: 0.25 })).strategies[0];
    const perps = (out.legs ?? []).filter((l) => /long|short/i.test(l.side));
    // 25% of ($90.92 + $22.87) = $28.45, half a leg: $14.22 of margin ÷ 1.03 at 3x = $41.42 each.
    expect(perps.map((l) => l.sizeUsd)).toEqual([41.42, 41.42]);
    expect(out.status).toBe("executable");
  });

  it("raises the leverage to clear the minimum when the user named none", () => {
    const funded = { ...ethPair(1), legs: [{ side: "Deposit", asset: "USDC", protocol: "Extended", chain: "Arbitrum", sizeUsd: 23.87 }, ...(ethPair(1).legs ?? [])] } as LLMStrategy;
    const out = enforceConformance([funded], "farming", ctx({ extended: extendedEmpty, balances, sizeShare: 0.25 })).strategies[0];
    const perps = (out.legs ?? []).filter((l) => /long|short/i.test(l.side));
    // $13.81 at 1x is under 0.01 ETH ($30.01 here): 3x is the lowest leverage that clears it.
    expect(perps.map((l) => l.leverage)).toEqual([3, 3]);
    expect(perps[0].sizeUsd).toBeGreaterThan(30.6);
    expect(out.status).toBe("executable");
    const kept = enforceConformance([funded], "farming", ctx({ extended: extendedEmpty, balances, sizeShare: 0.25, explicitLeverage: true })).strategies[0];
    expect(kept.status).toBe("blocked");
  });
});

describe("a deposit to Extended paid from the Hyperliquid account (owner's test, 2026-10-23)", () => {
  // $1.80 of USDC in the wallet on Arbitrum, $53 in the Hyperliquid account; the user asks to deposit $5 to Extended.
  const assets = [
    { symbol: "USDC", venue: "Wallet", chain: "Arbitrum", usd: 1.8 },
    { symbol: "USDC", venue: "Hyperliquid perps", chain: "Hyperliquid L1", usd: 53.43 },
  ];
  const plan = (sizeUsd: number, blockers?: string[]): LLMStrategy =>
    ({
      name: `Deposit $${sizeUsd} to Extended`,
      risk: "low",
      variantNote: "",
      summary: "",
      legs: [{ side: "Deposit", asset: "USDC", protocol: "Extended", chain: "Arbitrum", sizeUsd }],
      blockers,
    }) as LLMStrategy;

  it("raises the deposit to Extended's $10 minimum, withdraws enough from Hyperliquid, and runs", async () => {
    const { validateAndFixStrategy } = await import("@/lib/strategyIntegrity");
    const fixed = [plan(5, ["Extended's deposit minimum is $10; a $5 deposit is lost.", "Wallet holds $2 native USDC on Arbitrum, below the $5 needed."]), plan(10)].map((s) =>
      validateAndFixStrategy(s, { assets }),
    );
    const [withdraw, deposit] = fixed[0].legs;
    expect(deposit).toMatchObject({ side: "Deposit", protocol: "Extended", sizeUsd: 10 });
    expect(withdraw).toMatchObject({ side: "Withdraw", protocol: "Hyperliquid" });
    // What lands after the $1 fee, plus the wallet's $1.80, covers the $10 with the rounding margin.
    expect((withdraw.sizeUsd! - 1 + 1.8) * 0.995).toBeGreaterThanOrEqual(10);
    expect(fixed[0].fundingNotes?.join(" ")).toMatch(/minimum deposit is \$10/);

    const out = enforceConformance(fixed, "move", ctx({ extended: extendedEmpty, balances: { ...funded, walletDeployableUsd: 1.8 } }));
    // The $5 and $10 requests became the same plan: shown once, and executable.
    expect(out.strategies).toHaveLength(1);
    expect(out.strategies[0]).toMatchObject({ status: "executable" });
    expect(out.strategies[0].blockers).toBeUndefined();
  });
});
