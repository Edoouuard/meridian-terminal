import { safeNextPath } from "@/lib/betaGate";

export const metadata = { title: "Meridian — Private beta" };

export default async function BetaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "var(--color-bg, #0b0d10)",
      }}
    >
      <form
        method="POST"
        action="/api/beta-login"
        style={{ width: "100%", maxWidth: 320, display: "flex", flexDirection: "column", gap: 10 }}
      >
        <h1 style={{ fontSize: 18, margin: 0 }}>Meridian — private beta</h1>
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
          Enter the beta password to continue.
        </p>
        <input type="hidden" name="next" value={safeNextPath(next)} />
        <input
          type="password"
          name="password"
          required
          autoFocus
          autoComplete="current-password"
          placeholder="Password"
          style={{ fontSize: 14, padding: "8px 10px" }}
        />
        {error && (
          <p style={{ fontSize: 12, margin: 0, color: "var(--risk-warning, #e0a030)" }}>Wrong password.</p>
        )}
        <button type="submit" className="btn btn-primary" style={{ fontSize: 13, padding: "8px 10px" }}>
          Enter
        </button>
      </form>
    </main>
  );
}
