/**
 * solana — real Solana READ integration.
 *
 * Meridian reads a user-supplied Solana public key (base58) against the public
 * Solana mainnet RPC to fetch the SOL balance plus balances of a curated set of
 * top SPL tokens (USDC, JUP, RAY, mSOL, jitoSOL, PYTH, JTO, DRIFT, ORCA).
 *
 * READ-ONLY: no wallet adapter, no signing, no execution. All fetch helpers
 * swallow errors and return empty results + an error message rather than
 * throwing, so a transient RPC failure can never crash the terminal.
 *
 * Classifies `SOL_SPL_MINTS`: the SOL native token (`So111...1112`) is the
 * lamport-based native balance fetched via `getBalance`, not an SPL account.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

/** Public (rate-limited) Solana mainnet RPC. */
export const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

/** Native SOL mint (wrapped SOL token address; native SOL reads via getBalance). */
export const SOL_NATIVE_MINT = "So11111111111111111111111111111111111111112";

export interface SolMintInfo {
  /** Display symbol (e.g. "USDC"). */
  symbol: string;
  /** Human name (e.g. "USD Coin"). */
  name: string;
  /** Mainnet SPL mint address (base58). */
  mint: string;
  /** Canonical token decimals on mainnet. */
  decimals: number;
}

/**
 * Curated "top SPL tokens" map, keyed by SPL mint address (base58).
 * Real Solana mainnet mint addresses.
 */
export const SOL_SPL_MINTS: Record<string, SolMintInfo> = {
  // USDC (Circle) — https://solscan.io/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  // JUP (Jupiter) — https://solscan.io/token/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsrjSt
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsrjSt: { symbol: "JUP", name: "Jupiter", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsrjSt", decimals: 6 },
  // RAY (Raydium) — https://solscan.io/token/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": { symbol: "RAY", name: "Raydium", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", decimals: 6 },
  // mSOL (Marinade) — https://solscan.io/token/mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: "mSOL", name: "Marinade Staked SOL", mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", decimals: 9 },
  // jitoSOL (Jito) — https://solscan.io/token/J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: "jitoSOL", name: "Jito Staked SOL", mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", decimals: 9 },
  // PYTH (Pyth) — https://solscan.io/token/HZ1JovNiVYGr1NAtrNnaXqpq2eGPumbi6xtwA4KZPJki
  HZ1JovNiVYGr1NAtrNnaXqpq2eGPumbi6xtwA4KZPJki: { symbol: "PYTH", name: "Pyth Network", mint: "HZ1JovNiVYGr1NAtrNnaXqpq2eGPumbi6xtwA4KZPJki", decimals: 6 },
  // JTO (Jito Governance) — https://solscan.io/token/jtojtQpaU0FJhZ8Jwk4BQbvKm4TT9BnKCB5FJ7A4XAD
  jtojtQpaU0FJhZ8Jwk4BQbvKm4TT9BnKCB5FJ7A4XAD: { symbol: "JTO", name: "Jito Governance Token", mint: "jtojtQpaU0FJhZ8Jwk4BQbvKm4TT9BnKCB5FJ7A4XAD", decimals: 9 },
  // DRIFT (Drift) — https://solscan.io/token/DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7
  DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7: { symbol: "DRIFT", name: "Drift", mint: "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7", decimals: 6 },
  // ORCA (Orca) — https://solscan.io/token/orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kZtzfk
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kZtzfk: { symbol: "ORCA", name: "Orca", mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kZtzfk", decimals: 6 },
};

/** One SPL token balance entry, ready for display. */
export interface SolSplBalance {
  mint: string;
  symbol: string;
  /** Human-formatted token amount (e.g. "1,234.57"). */
  amountFormatted: string;
  /** Raw token unit amount (decimals applied). */
  amount: number;
}

let _connection: Connection | null = null;

/** Lazily-created singleton public Solana mainnet RPC connection. */
export function getSolanaConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(SOLANA_RPC_URL, "confirmed");
  }
  return _connection;
}

function fmtAmount(amount: number): string {
  if (!isFinite(amount)) return "0";
  if (amount === 0) return "0";
  if (amount >= 1000) return amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (amount >= 1) return amount.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return amount.toFixed(6);
}

/** Parse a Solana public key string; returns null if invalid (never throws). */
export function parsePubkey(value: string): PublicKey | null {
  try {
    return new PublicKey(value.trim());
  } catch {
    return null;
  }
}

/**
 * Fetch the native SOL balance (in SOL units) for a pubkey.
 * Returns 0 + error string on failure; never throws.
 */
export async function fetchSolBalance(pubkey: PublicKey | string): Promise<{ sol: number; error?: string }> {
  try {
    const key = typeof pubkey === "string" ? new PublicKey(pubkey) : pubkey;
    const lamports = await getSolanaConnection().getBalance(key);
    return { sol: lamports / 1e9 };
  } catch (err) {
    return { sol: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetch SPL balances for the curated top-token set for a pubkey.
 * Reads all the owner's parsed token accounts once and maps known mints.
 * Returns [] + error string on failure; never throws.
 */
export async function fetchSplBalances(
  pubkey: PublicKey | string,
): Promise<{ balances: SolSplBalance[]; error?: string }> {
  try {
    const key = typeof pubkey === "string" ? new PublicKey(pubkey) : pubkey;
    const { value } = await getSolanaConnection().getParsedTokenAccountsByOwner(key, {
      programId: TOKEN_PROGRAM_ID,
    });

    const balances: SolSplBalance[] = [];
    for (const acct of value) {
      const rawMint = acct.account.data.parsed?.info?.mint as string;
      const info = SOL_SPL_MINTS[rawMint];
      if (!info) continue; // not in our curated set

      const tokenAmount = acct.account.data.parsed?.info?.tokenAmount;
      const amount = typeof tokenAmount?.uiAmount === "number" ? tokenAmount.uiAmount : Number(tokenAmount?.amount ?? 0) / 10 ** (tokenAmount?.decimals ?? info.decimals);
      if (amount <= 0) continue; // skip dust / empty

      balances.push({
        mint: rawMint,
        symbol: info.symbol,
        amount,
        amountFormatted: fmtAmount(amount),
      });
    }

    // Stable order: USDC first, then by curated key order.
    balances.sort((a, b) => (a.symbol === "USDC" ? -1 : b.symbol === "USDC" ? 1 : a.symbol.localeCompare(b.symbol)));
    return { balances };
  } catch (err) {
    return { balances: [], error: err instanceof Error ? err.message : String(err) };
  }
}