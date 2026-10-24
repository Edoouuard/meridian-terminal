"use client";

import { startTour } from "@/components/ProductTour";
import { DEFAULT_SETTINGS, useUiSettings, type StartPage, type TextSize, type ThemeChoice } from "@/lib/uiSettings";
import { FEATURES } from "@/lib/features";

function Choice<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg settings-seg" role="radiogroup" aria-label={name}>
      {options.map(([v, label]) => (
        <label key={v} className="seg-opt">
          <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <p className="settings-row__title">{title}</p>
        <p className="settings-row__hint">{hint}</p>
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  );
}

/** Appearance and layout preferences, kept in this browser (lib/uiSettings.ts). */
export function SettingsPage() {
  const [s, update] = useUiSettings();
  const pages: [StartPage, string][] = [
    ["terminal", "Terminal"],
    ["portfolio", "Portfolio"],
    ["earn", "Earn"],
    ...(FEATURES.perps && s.showAdvanced ? ([["perps", "Perps"]] as [StartPage, string][]) : []),
    ["discover", "Discover"],
  ];
  return (
    <div className="page__narrow settings">
      <section className="panel-card">
        <h2 className="settings__section">Appearance</h2>
        <Row title="Theme" hint="Night is the default. Match device follows your phone or computer.">
          <Choice<ThemeChoice> name="theme" value={s.theme} onChange={(theme) => update({ theme })} options={[["dark", "Night"], ["light", "Day"], ["system", "Match device"]]} />
        </Row>
        <Row title="Text size" hint="Large makes every page bigger and easier to read.">
          <Choice<TextSize> name="text-size" value={s.textSize} onChange={(textSize) => update({ textSize })} options={[["normal", "Normal"], ["large", "Large"]]} />
        </Row>
      </section>

      <section className="panel-card">
        <h2 className="settings__section">Layout</h2>
        <Row title="Open Meridian on" hint="The page you land on each time you come back.">
          <Choice<StartPage> name="start-page" value={s.startPage} onChange={(startPage) => update({ startPage })} options={pages} />
        </Row>
        {FEATURES.perps && (
          <Row title="Advanced tools" hint="Perps, the neutral bot and arbitrage. Turn them off for a simpler Meridian focused on lending, staking and yields.">
            <Choice<"on" | "off"> name="advanced" value={s.showAdvanced ? "on" : "off"} onChange={(v) => update({ showAdvanced: v === "on" })} options={[["on", "Show"], ["off", "Hide"]]} />
          </Row>
        )}
      </section>

      <section className="panel-card">
        <h2 className="settings__section">Getting around</h2>
        <Row title="Product tour" hint="A one-minute walk through the terminal.">
          <button type="button" className="btn btn-secondary" onClick={startTour}>
            Replay the tour
          </button>
        </Row>
        <Row title="Reset" hint="Back to the default look and layout.">
          <button type="button" className="btn btn-secondary" onClick={() => update(DEFAULT_SETTINGS)}>
            Reset settings
          </button>
        </Row>
      </section>
      <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
        Settings are saved in this browser only.
      </p>
    </div>
  );
}
