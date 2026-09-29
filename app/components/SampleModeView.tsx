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
 *
 * THE DEMO ALWAYS HAS A WAY OUT. It used to have none: the only banner
 * with an exit sat behind a flag that defaults off, and every nav link
 * led to a real page that bounces an empty install to /onboard without a
 * word. So the page carries a sample-data bar that is never gated
 * ("Start with your own apps", which clears the demo and opens
 * onboarding, and "Back to welcome"), and HomeLoader renders
 * SampleModeNav instead of the full Nav: its links stay in the demo or
 * leave through that same named exit.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  clearSampleApps,
  readSampleApps,
  type SampleApp,
} from "@/lib/sample-apps";
import { useFlagValuesWithDefaults } from "../../lib/use-flag-bundle";
import AccessibilityEntryButton from "./AccessibilityEntryButton";
import BrandWordmark from "./BrandWordmark";
import "./sample-mode.css";

/** The dashboard's href in sample mode: the brand link stays in the demo. */
const SAMPLE_HOME = "/dashboard?sample=1";

/**
 * The nav bar for sample mode. The full Nav's links (Apps, Stats,
 * Settings…) all lead to pages that send an install with no apps to
 * onboarding, which read as the demo breaking. This one says it is a
 * demo, keeps the brand link inside it, and puts the exit on screen
 * while the user scrolls.
 */
export function SampleModeNav() {
  const tNav = useTranslations("nav");
  const tSample = useTranslations("sample_mode");
  return (
    <nav className="nav sample-mode-nav">
      <Link
        aria-label={tSample("nav_home_aria")}
        className="nav-brand"
        href={SAMPLE_HOME}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt=""
          className="nav-brand-icon"
          height={28}
          src="/brand-icon.png"
          width={28}
        />
        <BrandWordmark
          ariaLabel={tNav("brand")}
          className="nav-brand-wordmark"
          height={20}
        />
      </Link>
      <span className="sample-mode-nav-chip">{tSample("nav_chip")}</span>
      <div className="nav-right">
        {/* This nav has no drawer, so on a phone the accessibility panel
            gets its own entry here (the panel's button sits at the end of
            the page below 480px). Hidden on wider screens, where the
            floating button is in the corner. */}
        <AccessibilityEntryButton
          className="sample-mode-a11y"
          iconOnly
          testId="sample-nav-a11y"
        />
        <Link
          className="btn btn-sm btn-primary sample-mode-exit"
          href="/onboard"
          onClick={clearSampleApps}
        >
          {tSample("start_own_apps")}
        </Link>
      </div>
    </nav>
  );
}

export default function SampleModeView() {
  const tSample = useTranslations("sample_mode");
  // `flag.dashboard.sample_data_banner` (default off) gates the extra
  // "Clear samples" action in the bar, which empties the demo without
  // leaving it. It used to gate the whole banner, which, with the flag
  // off by default and nothing to turn it on, meant the demo had no exit.
  // The bar and its two exits are never gated.
  // Resolved through the shared `GET /api/feature-flags` bundle; the
  // hook seeds the hard defaults for the first paint and then corrects.
  const flags = useFlagValuesWithDefaults([
    "flag.dashboard.sample_data_banner",
  ]);
  const clearSamplesOn = flags["flag.dashboard.sample_data_banner"] === "on";

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
      <section aria-label={tSample("bar_aria")} className="sample-data-banner">
        <p className="sample-data-banner-text">
          <strong>{tSample("banner_lead")}</strong>{" "}
          {tSample("bar_body", { count: apps.length })}
        </p>
        <div className="sample-data-banner-actions">
          <Link
            className="btn btn-primary btn-sm"
            href="/onboard"
            onClick={clearSampleApps}
          >
            {tSample("start_own_apps")}
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/welcome">
            {tSample("back_to_welcome")}
          </Link>
          {clearSamplesOn && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleClear}
              type="button"
            >
              {tSample("clear_samples")}
            </button>
          )}
        </div>
      </section>

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
