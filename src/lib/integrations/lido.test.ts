import { describe, expect, it } from "vitest";
import { isClaimable, type LidoWithdrawalRequest } from "@/lib/integrations/lido";

function req(partial: Partial<LidoWithdrawalRequest>): LidoWithdrawalRequest {
  return { id: 1n, amountOfStETH: 1_000_000_000_000_000_000n, timestamp: 0n, isFinalized: false, isClaimed: false, ...partial };
}

describe("lido — isClaimable", () => {
  it("is claimable once finalized and not yet claimed", () => {
    expect(isClaimable(req({ isFinalized: true, isClaimed: false }))).toBe(true);
  });

  it("is not claimable while still pending finalization", () => {
    expect(isClaimable(req({ isFinalized: false, isClaimed: false }))).toBe(false);
  });

  it("is not claimable once already claimed", () => {
    expect(isClaimable(req({ isFinalized: true, isClaimed: true }))).toBe(false);
  });
});
