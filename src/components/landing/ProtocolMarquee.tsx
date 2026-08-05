const PROTOCOLS = ["Aave", "SparkLend", "Compound", "Morpho", "Lido", "Pendle", "Hyperliquid", "Extended", "Variational", "Uniswap", "GMX", "dYdX", "Jupiter", "Curve", "Sky"];
const CHAINS = ["Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "Avalanche", "BNB Chain", "Gnosis", "Scroll", "zkSync Era", "Linea", "Mantle", "Metis", "Fantom", "Sonic", "Celo"];

export function ProtocolMarquee() {
  const items = [...PROTOCOLS, ...CHAINS];
  return (
    <div className="ticker-viewport" style={{ borderTop: "1px solid var(--color-divider)", borderBottom: "1px solid var(--color-divider)" }}>
      <div className="ticker-track" style={{ padding: "var(--space-4) 0", animationDuration: "52s" }}>
        {items.map((name, i) => (
          <span
            key={i}
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: 22,
              padding: "0 var(--space-6)",
              color: "color-mix(in srgb, var(--color-text) 45%, transparent)",
              flex: "none",
            }}
          >
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}
