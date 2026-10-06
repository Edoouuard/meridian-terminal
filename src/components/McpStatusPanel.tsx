"use client";

import { useQuery } from "@tanstack/react-query";
import type { McpProviderStatus } from "@/lib/mcp/types";

/**
 * McpStatusPanel — Shows the live health status of all 4 MCP providers
 * (Haiku, deBridge, LI.FI, Base) in a compact panel.
 */
export function McpStatusPanel() {
  const { data: providers, isLoading } = useQuery({
    queryKey: ["mcp-status"],
    queryFn: async () => {
      const res = await fetch("/api/mcp?action=health");
      if (!res.ok) return [];
      const data = await res.json();
      return (data.providers ?? []) as McpProviderStatus[];
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  return (
    <div className="panel" style={{ padding: "12px 14px" }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600 }}>MCP Providers</h3>
      {isLoading && (
        <p style={{ fontSize: 11, color: "var(--color-neutral-500)", margin: 0 }}>Checking health…</p>
      )}
      {providers && providers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {providers.map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 11,
                padding: "3px 0",
                borderBottom: "1px solid var(--color-neutral-200)",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    backgroundColor: p.healthy ? "var(--color-good)" : "var(--color-serious)",
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontWeight: 500 }}>{p.name}</span>
              </span>
              <span style={{ color: "var(--color-neutral-500)" }}>
                {p.healthy
                  ? `${p.latencyMs}ms`
                  : "offline"}
              </span>
            </div>
          ))}
        </div>
      )}
      {!isLoading && (!providers || providers.length === 0) && (
        <p style={{ fontSize: 11, color: "var(--color-neutral-500)", margin: 0 }}>No providers configured</p>
      )}
    </div>
  );
}
