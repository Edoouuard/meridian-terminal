import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Meridian — DeFi Terminal",
  description: "Portfolio, cross-protocol yield radar, and prompt-to-trade execution.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
