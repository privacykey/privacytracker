"use client";

/**
 * Bulk privacy-policy operations: re-scrape the source text for every
 * tracked app, or re-scrape *and* re-summarise with the configured AI
 * provider.
 *
 * Both buttons share one `running` value rather than having their own,
 * because the two runs contend for the same server-side mutex — starting
 * either while the other is in flight would just 409. Disabling both
 * while any run is active says that plainly.
 *
 * Anchor id `privacy-policies-bulk` matches the SettingsSidebar entry —
 * see ./README.md.
 */

import { useTranslations } from "next-intl";
import type { PolicyBulkPhase } from "./types";

export default function PrivacyPoliciesBulkSection({
  running,
  onRun,
  force,
  setForce,
  summary,
}: {
  /** Which run is in flight, or null when idle. */
  running: PolicyBulkPhase | null;
  onRun: (phase: PolicyBulkPhase) => void;
  force: boolean;
  setForce: (next: boolean) => void;
  /** Human-readable result of the previous run; empty/null when none. */
  summary: string | null;
}) {
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tPolicyCard = useTranslations("settings.privacy_policies_card");

  const busy = running !== null;

  return (
    <div className="settings-section" id="privacy-policies-bulk">
      <h2 className="settings-section-title">
        {tSections("privacy_policies")}
      </h2>
      <p className="settings-section-subtitle">{tSub("privacy_policies")}</p>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          marginTop: 12,
        }}
      >
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => onRun("fetch")}
          title={tPolicyCard("rescrape_title")}
          type="button"
        >
          {running === "fetch" ? (
            <>
              <span className="spinner" /> {tPolicyCard("rescrape_busy")}
            </>
          ) : (
            tPolicyCard("rescrape")
          )}
        </button>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => onRun("all")}
          title={tPolicyCard("summarise_title")}
          type="button"
        >
          {running === "all" ? (
            <>
              <span className="spinner" /> {tPolicyCard("summarise_busy")}
            </>
          ) : (
            tPolicyCard("summarise")
          )}
        </button>
      </div>

      <label className="settings-checkbox-row" style={{ marginTop: 14 }}>
        <input
          checked={force}
          className="settings-checkbox"
          disabled={busy}
          onChange={(event) => setForce(event.target.checked)}
          type="checkbox"
        />
        <span>
          {tPolicyCard("force_label")}
          <span
            className="settings-field-help"
            style={{ display: "block", marginTop: 4 }}
          >
            {tPolicyCard("force_help")}
          </span>
        </span>
      </label>

      {summary ? (
        <p
          style={{
            marginTop: 12,
            fontSize: 13,
            color: "var(--text-2)",
          }}
        >
          {tPolicyCard("last_run_lead")} {summary}
        </p>
      ) : null}
    </div>
  );
}
