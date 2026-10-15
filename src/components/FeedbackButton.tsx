"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { ConfirmDialog } from "@/components/ConfirmDialog";

/**
 * "Report a bug" for beta testers: a short form posted to /api/feedback
 * (server logs + Sentry). Sends the page, the last request typed and, only
 * when the tester ticks it, the connected wallet address.
 */
export function FeedbackButton({ lastRequest, className = "tour-trigger" }: { lastRequest?: string; className?: string }) {
  const { address, chainId } = useAccount();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [shareWallet, setShareWallet] = useState(false);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function send() {
    setStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          message,
          contact: contact || undefined,
          page: window.location.pathname,
          lastRequest,
          wallet: shareWallet ? address : undefined,
          chainId,
        }),
      });
      if (!res.ok) throw new Error();
      setStatus("sent");
      setMessage("");
      setTimeout(() => {
        setOpen(false);
        setStatus("idle");
      }, 1500);
    } catch {
      setStatus("error");
    }
  }

  const field = { width: "100%", boxSizing: "border-box", fontSize: 13, padding: 8, borderRadius: 6, border: "1px solid var(--color-divider)", background: "var(--color-bg)", color: "var(--color-text)" } as const;

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="Tell us what went wrong">
        Report a bug
      </button>
      <ConfirmDialog
        open={open}
        title="Report a bug"
        body={
          status === "sent" ? (
            <p style={{ margin: 0 }}>Thanks — it&apos;s on its way.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ fontSize: 12 }}>
                What happened, and what did you expect?
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} maxLength={4000} style={{ ...field, marginTop: 4, resize: "vertical" }} autoFocus />
              </label>
              <label style={{ fontSize: 12 }}>
                How to reach you (optional: Telegram, X, email)
                <input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={200} style={{ ...field, marginTop: 4 }} />
              </label>
              {address && (
                <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={shareWallet} onChange={(e) => setShareWallet(e.target.checked)} />
                  Include my wallet address (helps us reproduce it)
                </label>
              )}
              {lastRequest && <p style={{ margin: 0, fontSize: 11, color: "var(--color-neutral-500)" }}>Your last request is attached: “{lastRequest.slice(0, 80)}{lastRequest.length > 80 ? "…" : ""}”</p>}
              {status === "error" && <p style={{ margin: 0, fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>Couldn&apos;t send it. Try again in a moment.</p>}
            </div>
          )
        }
        confirmLabel={status === "sending" ? "Sending…" : "Send"}
        confirmDisabled={status === "sending" || status === "sent" || message.trim().length < 5}
        onConfirm={() => void send()}
        onCancel={() => {
          setOpen(false);
          setStatus("idle");
        }}
      />
    </>
  );
}
