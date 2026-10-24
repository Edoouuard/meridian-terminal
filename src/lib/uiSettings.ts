/**
 * uiSettings.ts — how a person likes the terminal: day or night, text size,
 * the page it opens on, and whether the advanced perp tools show. Stored in
 * this browser only (localStorage); a blocked or empty storage falls back to
 * the defaults. Applied to <html> as data attributes the CSS reads
 * (data-theme, data-text), and set before first paint by THEME_BOOT_SCRIPT.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";

export type ThemeChoice = "dark" | "light" | "system";
export type TextSize = "normal" | "large";
export type StartPage = "terminal" | "portfolio" | "earn" | "perps" | "discover";

export interface UiSettings {
  theme: ThemeChoice;
  textSize: TextSize;
  startPage: StartPage;
  /** Perps page, arbitrage and the neutral bot. Off = a simpler terminal for lending, staking and yields. */
  showAdvanced: boolean;
}

export const DEFAULT_SETTINGS: UiSettings = { theme: "dark", textSize: "normal", startPage: "terminal", showAdvanced: true };

import { SETTINGS_KEY } from "./themeBoot";

export { SETTINGS_KEY };
const CHANGE_EVENT = "meridian:ui-settings";

const THEMES: ThemeChoice[] = ["dark", "light", "system"];
const SIZES: TextSize[] = ["normal", "large"];
const PAGES: StartPage[] = ["terminal", "portfolio", "earn", "perps", "discover"];

/** Whatever was stored, as valid settings (unknown or broken values fall back to the defaults). */
export function parseSettings(raw: string | null): UiSettings {
  let v: Partial<Record<keyof UiSettings, unknown>> = {};
  try {
    v = raw ? (JSON.parse(raw) as typeof v) : {};
  } catch {
    v = {};
  }
  return {
    theme: THEMES.includes(v.theme as ThemeChoice) ? (v.theme as ThemeChoice) : DEFAULT_SETTINGS.theme,
    textSize: SIZES.includes(v.textSize as TextSize) ? (v.textSize as TextSize) : DEFAULT_SETTINGS.textSize,
    startPage: PAGES.includes(v.startPage as StartPage) ? (v.startPage as StartPage) : DEFAULT_SETTINGS.startPage,
    showAdvanced: typeof v.showAdvanced === "boolean" ? v.showAdvanced : DEFAULT_SETTINGS.showAdvanced,
  };
}

export function loadSettings(): UiSettings {
  try {
    return parseSettings(window.localStorage.getItem(SETTINGS_KEY));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** The theme actually shown: "system" follows the device. */
export function resolveTheme(theme: ThemeChoice, prefersLight: boolean): "dark" | "light" {
  return theme === "system" ? (prefersLight ? "light" : "dark") : theme;
}

function apply(s: UiSettings) {
  const root = document.documentElement;
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
  root.dataset.theme = resolveTheme(s.theme, prefersLight);
  root.dataset.text = s.textSize;
}

export function saveSettings(next: UiSettings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Private window or blocked storage: the choice holds for this visit only.
  }
  apply(next);
  window.dispatchEvent(new CustomEvent<UiSettings>(CHANGE_EVENT, { detail: next }));
}

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  const onDevice = () => apply(loadSettings());
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  mq?.addEventListener?.("change", onDevice);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
    mq?.removeEventListener?.("change", onDevice);
  };
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(SETTINGS_KEY);
  } catch {
    return null;
  }
}

/** The settings, kept in sync across components and tabs; applies them to <html> and follows the device theme. */
export function useUiSettings(): [UiSettings, (patch: Partial<UiSettings>) => void] {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const settings = useMemo(() => parseSettings(raw), [raw]);
  useEffect(() => apply(settings), [settings]);
  const update = (patch: Partial<UiSettings>) => saveSettings({ ...loadSettings(), ...patch });
  return [settings, update];
}
