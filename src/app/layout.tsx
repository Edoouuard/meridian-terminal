import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/providers/Providers";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export const metadata: Metadata = {
  title: "Meridian: DeFi Terminal",
  description: "Prompt-to-trade DeFi terminal. Portfolio tracking, yield radar, and order routing across 16 chains and 20+ protocols — Aave, Morpho, Lido, Pendle, Hyperliquid, Uniswap and more.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <ErrorBoundary>
          <Providers>{children}</Providers>
        </ErrorBoundary>
      </body>
    </html>
  );
}
