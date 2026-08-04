"use client";

import { useState } from "react";

type Status = "idle" | "submitting" | "success" | "error";

export function WaitlistForm({ align = "left" }: { align?: "left" | "center" }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "submitting" || status === "success") return;
    setStatus("submitting");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setMessage(data?.error || "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }
      setStatus("success");
    } catch {
      setMessage("Something went wrong. Please try again.");
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <p className="waitlist-success" style={{ textAlign: align }}>
        You are on the list. We will email you the moment Meridian opens.
      </p>
    );
  }

  return (
    <div style={{ textAlign: align }}>
      <form className="waitlist-form" onSubmit={submit} style={{ justifyContent: align === "center" ? "center" : "flex-start" }}>
        <input
          type="email"
          required
          className="input"
          placeholder="you@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Email address"
          disabled={status === "submitting"}
        />
        <button className="btn btn-primary" type="submit" disabled={status === "submitting"}>
          {status === "submitting" ? "Joining…" : "Join the waitlist"}
        </button>
      </form>
      {status === "error" && (
        <p className="text-muted" style={{ fontSize: 13, marginTop: 8 }}>
          {message}
        </p>
      )}
    </div>
  );
}
