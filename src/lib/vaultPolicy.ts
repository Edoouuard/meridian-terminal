/**
 * Vaults below this TVL are never suggested or picked for a deposit: sorted by
 * APY or risk score, live feeds otherwise lead with tiny or reward-inflated
 * vaults (e.g. $1.4k TVL).
 */
export const MIN_VAULT_TVL_USD = 1_000_000;
