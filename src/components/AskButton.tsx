"use client";

import { askMeridian } from "@/lib/askBus";

/** Small call to action that sends a prepared prompt to the chat. */
export function AskButton({ prompt, label = "Ask Meridian", title }: { prompt: string; label?: string; title?: string }) {
  return (
    <button type="button" className="ask-btn" onClick={() => askMeridian(prompt)} title={title ?? prompt}>
      {label} <span aria-hidden="true">→</span>
    </button>
  );
}
