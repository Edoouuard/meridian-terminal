/**
 * Feature flags for surfaces that haven't been proven end to end with a real
 * wallet yet (see MASTER.md, Phase 1). Off by default; set the env var to "1"
 * in Vercel to bring a surface back once its golden path has been validated.
 */
export const FEATURES = {
  /** Perp venues: Hyperliquid, Extended, TxFlow. */
  perps: process.env.NEXT_PUBLIC_FEATURE_PERPS === "1",
  /** Solana wallet panel. */
  solana: process.env.NEXT_PUBLIC_FEATURE_SOLANA === "1",
} as const;
