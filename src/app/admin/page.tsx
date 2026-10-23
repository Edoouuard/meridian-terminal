import { AdminSeats } from "./AdminSeats";

export const metadata = { title: "Meridian — Early access admin" };

export default function AdminPage() {
  return (
    <main style={{ minHeight: "100vh", display: "flex", justifyContent: "center", padding: "48px 16px", background: "var(--color-bg, #0b0d10)" }}>
      <AdminSeats />
    </main>
  );
}
