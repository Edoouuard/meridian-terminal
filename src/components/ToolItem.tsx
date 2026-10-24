"use client";

import { useEffect, useState, type ReactNode } from "react";
import { OPEN_TOOLS_EVENT } from "@/lib/neutralBot/bus";

/**
 * One tool in the Tools tab: a single line (name + what it does) that opens
 * on click, so every tool is visible at a glance instead of a long stack of
 * cards. Opens on its own when another view points at it (openToolsAt(id)).
 * A tool whose panel renders nothing (no wallet yet) hides itself (CSS :has).
 */
export function ToolItem({ id, title, summary, defaultOpen = false, children }: { id?: string; title: string; summary: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (!id) return;
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<unknown>).detail === id) setOpen(true);
    };
    window.addEventListener(OPEN_TOOLS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TOOLS_EVENT, onOpen);
  }, [id]);
  return (
    <details id={id} className="tool-item" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="tool-item__summary">
        <span className="tool-item__title">{title}</span>
        <span className="tool-item__hint">{summary}</span>
      </summary>
      <div className="tool-item__body">{children}</div>
    </details>
  );
}

/** A small heading over a group of tools. */
export function ToolGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tool-group">
      <h6 className="tool-group__label">{label}</h6>
      <div className="tool-group__items">{children}</div>
    </div>
  );
}
