"use client";

import { createContext, useContext } from "react";
import type { TradePlan } from "@/lib/tradePlan";

/**
 * Which strategy and step an execute button belongs to. StrategyLegs provides
 * it around each leg, so any button deep inside (Morpho, Pendle, bridge…)
 * can record its confirmation against the strategy without prop drilling.
 */
export const StrategyLegContext = createContext<{ plan: TradePlan; legIndex: number } | null>(null);

export function useStrategyLeg() {
  return useContext(StrategyLegContext);
}
