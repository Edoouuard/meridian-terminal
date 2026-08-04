import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/providers/Providers";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export const metadata: Metadata = {
  title: "Meridian: DeFi Terminal",
  description: "Portfolio tracking, protocol yield radar, and prompt to trade execution.",
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
