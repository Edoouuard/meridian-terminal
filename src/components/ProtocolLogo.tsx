"use client";

import { useState } from "react";

/**
 * DefiLlama's icon slugs for the names Meridian shows. A name not listed is
 * slugified ("Gains Network" → "gains-network"); a logo that doesn't load
 * falls back to the protocol's initial, so a miss never shows a broken image.
 */
const SLUGS: Record<string, string> = {
  "aave": "aave",
  "aave v3": "aave",
  "morpho": "morpho",
  "morpho blue": "morpho",
  "compound": "compound-finance",
  "compound v3": "compound-finance",
  "spark": "spark",
  "sky": "sky",
  "sdai": "spark",
  "lido": "lido",
  "rocket pool": "rocket-pool",
  "frax": "frax",
  "eigenlayer": "eigenlayer",
  "ether.fi": "ether.fi",
  "etherfi": "ether.fi",
  "renzo": "renzo",
  "kelp": "kelp",
  "pendle": "pendle",
  "fluid": "fluid",
  "yearn": "yearn-finance",
  "ethena": "ethena",
  "curve": "curve-finance",
  "curve llamalend": "curve-finance",
  "uniswap": "uniswap",
  "hyperliquid": "hyperliquid",
  "hyperliquid hlp": "hyperliquid",
  "extended": "extended",
  "txflow": "txflow",
  "lighter": "lighter",
  "paradex": "paradex",
  "jupiter": "jupiter",
  "gmx": "gmx",
  "gains network": "gains-network",
  "dydx": "dydx",
  "li.fi": "li.fi",
  "lifi": "li.fi",
  "debridge": "debridge",
};

export function protocolSlug(name: string): string {
  const key = name.trim().toLowerCase();
  return SLUGS[key] ?? key.replace(/\s+v\d+$/, "").replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
}

/** A protocol's logo; its name shows on hover and to screen readers. */
export function ProtocolLogo({ name, size = 20, slug }: { name: string; size?: number; slug?: string }) {
  const [failed, setFailed] = useState(false);
  const src = `https://icons.llamao.fi/icons/protocols/${slug ?? protocolSlug(name)}?w=${size * 2}&h=${size * 2}`;
  return (
    <span className="plogo" style={{ width: size, height: size }} title={name}>
      {failed ? (
        <span className="plogo__fallback" aria-label={name} role="img" style={{ fontSize: Math.round(size * 0.48) }}>
          {name.trim().charAt(0).toUpperCase()}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- remote CDN icon, tiny and cached; next/image would need a remote pattern for no gain.
        <img src={src} alt={name} width={size} height={size} loading="lazy" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

/** Several logos side by side (a strategy's protocols). */
export function ProtocolLogos({ names, size = 20 }: { names: string[]; size?: number }) {
  return (
    <span className="plogos">
      {names.map((n) => (
        <ProtocolLogo key={n} name={n} size={size} />
      ))}
    </span>
  );
}
