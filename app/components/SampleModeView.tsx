"use client";

/**
 * SampleModeView — renders the 10 sessionStorage-backed demo apps as a
 * static preview when the user clicked "Try with sample data" on the
 * welcome screen.
 *
 * Bypasses the dashboard's normal empty-state redirect via the `?sample=1`
 * query param the welcome page sends. Closing the tab clears the demo;
 * importing real apps clears it via the auto-clear logic.
 *
 * Strictly a preview surface — the demo apps don't appear in the real app
 * grid. This component is the dashboard's whole render when sample mode is
 * active and no real apps exist.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  clearSampleApps,
  readSampleApps,
  type SampleApp,
} from "@/lib/sample-apps";
import { useFlag } from "../../lib/feature-flags-hooks";

export default function SampleModeView() {
  const tSample = useTranslations("sample_mode");
  // Wave I: yellow "Showing sample data" banner is the surface gated by
  // `flag.dashboard.sample_data_banner`. The banner default is off — only
  // the welcome → ?sample=1 path resolves it on for the duration of the
  // session — but we still expose the flag so users running sample mode
  // can dismiss the banner without leaving sample mode.
  const sampleBannerOn = useFlag("flag.dashboard.sample_data_banner") === "on";

  const [apps, setApps] = useState<SampleApp[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setApps(readSampleApps());
    setLoaded(true);
  }, []);

  function handleClear() {
    clearSampleApps();
    setApps([]);
  }

  if (!loaded) {
    return <p style={{ padding: 32 }}>{tSample("loading")}</p>;
  }

  if (apps.length === 0) {
    return (
      <div className="page-container" style={{ padding: 32 }}>
        <h1 className="page-title">{tSample("empty_title")}</h1>
        <p style={{ color: "var(--text-3)", marginTop: 12 }}>
          {tSample("empty_body")}
        </p>
        <Link
          className="btn btn-primary"
          href="/welcome"
          style={{ marginTop: 16, display: "inline-block" }}
        >
          {tSample("back_to_welcome")}
        </Link>
      </div>
    );
  }

  return (
    <div
      className="page-container home-page sample-mode-view"
      style={{ padding: 32 }}
    >
      {sampleBannerOn && (
        <div
          className="sample-data-banner"
          role="status"
          style={{
            background: "var(--surface-warning, #fff7e6)",
            border: "1px solid var(--border-warning, #f0c060)",
            borderRadius: 8,
            padding: "12px 16px",
            marginBottom: 24,
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <strong>{tSample("banner_lead")}</strong>{" "}
            {tSample("banner_body", { count: apps.length })}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link className="btn btn-primary btn-sm" href="/onboard">
              {tSample("add_real_apps")}
            </Link>
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleClear}
              type="button"
            >
              {tSample("clear_samples")}
            </button>
          </div>
        </div>
      )}

      <h1 className="page-title">{tSample("page_title")}</h1>
      <p style={{ color: "var(--text-3)", maxWidth: 640, marginBottom: 24 }}>
        {tSample("page_subtitle")}
      </p>

      <div
        className="sample-app-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        {apps.map((app) => (
          <SampleAppCard app={app} key={app.id} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function SampleAppCard({ app }: { app: SampleApp }) {
  const tSample = useTranslations("sample_mode");
  const [open, setOpen] = useState(false);

  const riskColour =
    app.riskTier === "high"
      ? "#d04040"
      : app.riskTier === "moderate"
        ? "#e69020"
        : app.riskTier === "low"
          ? "#5aa860"
          : "#888";

  return (
    <article
      className="sample-app-card"
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 16,
        background: "var(--surface)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 32, lineHeight: 1 }}>{app.iconEmoji}</span>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {app.name}
          </h2>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-3)" }}>
            {app.developer}
          </p>
        </div>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            color: riskColour,
            border: `1px solid ${riskColour}`,
            padding: "2px 6px",
            borderRadius: 4,
          }}
        >
          {app.riskTier}
        </span>
      </header>

      <p style={{ fontSize: 13, color: "var(--text-2)", margin: "8px 0" }}>
        {app.aiSummary.paragraph.slice(0, 140)}
        {app.aiSummary.paragraph.length > 140 ? "…" : ""}
      </p>

      {open && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <strong>{tSample("highlights_label")}</strong>
          <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
            {app.aiSummary.highlights.map((h, i) => (
              <li key={i} style={{ marginBottom: 2 }}>
                {h}
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
        style={{ marginTop: 8, padding: "4px 8px", fontSize: 12 }}
        type="button"
      >
        {open ? tSample("show_less") : tSample("show_more")}
      </button>
    </article>
  );
}
