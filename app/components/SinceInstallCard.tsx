"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { ChangeEntry, SinceInstallDiff } from "../../lib/changelog-types";
import { formatDate as formatDateWithMode } from "../../lib/date-format";
import { useDateFormat } from "../../lib/date-format-hook";

interface SinceInstallResponse {
  appId: string;
  sinceInstall: SinceInstallDiff | null;
}

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; data: SinceInstallDiff | null }
  | { status: "error" };

/**
 * "Since you added this app" card — the cumulative privacy-label diff from
 * the install-era baseline snapshot to the latest one. Sits above the
 * change-by-change timeline on the History tab and answers the question the
 * incremental rows don't: *net* of everything, what's different now versus
 * when you started tracking this app?
 *
 * Self-hiding: renders nothing while loading, on error, or when there's no
 * usable baseline yet — so it never adds empty chrome to the tab. Fetches
 * its own data (mirrors HistoryStatsStrip) so the server detail page stays
 * untouched.
 */
export default function SinceInstallCard({ appId }: { appId: string }) {
  const t = useTranslations("since_install");
  const dateMode = useDateFormat();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetch(`/api/apps/${encodeURIComponent(appId)}/since-install`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`);
        }
        return (await res.json()) as SinceInstallResponse;
      })
      .then((body) => {
        if (!cancelled) {
          setState({ status: "loaded", data: body.sinceInstall });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  // Nothing to show until we have a real, multi-snapshot baseline.
  if (state.status !== "loaded" || !state.data) {
    return null;
  }
  const data = state.data;
  if (data.isSingleSnapshot) {
    return null;
  }

  const formatDay = (ms: number) => formatDateWithMode(ms, dateMode);
  const hasChanges = data.addedCount > 0 || data.removedCount > 0;

  // Subline: which baseline we actually compared against, plus an archive
  // note when the baseline was reconstructed from a Wayback capture.
  const comparedLine =
    (data.baselineIsApprox
      ? t("compared_approx", { date: formatDay(data.baselineDate) })
      : t("compared_install", { date: formatDay(data.baselineDate) })) +
    (data.baselineSource === "wayback" ? t("from_archive_suffix") : "");

  return (
    <section
      aria-label={t("card_title")}
      className="since-install-card"
      style={{
        margin: "0 0 16px",
        padding: 14,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          fontWeight: 700,
          marginBottom: 6,
        }}
      >
        <span aria-hidden="true">📍</span>
        {t("card_title")}
      </div>

      <div style={{ fontSize: 14, color: "var(--text-1)", marginBottom: 4 }}>
        {hasChanges ? (
          <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 8 }}>
            {data.addedCount > 0 && (
              <strong style={{ color: "var(--red, #c0392b)" }}>
                {t("summary_added", { count: data.addedCount })}
              </strong>
            )}
            {data.removedCount > 0 && (
              <strong style={{ color: "var(--green, #1f8a4c)" }}>
                {t("summary_removed", { count: data.removedCount })}
              </strong>
            )}
          </span>
        ) : (
          <span style={{ color: "var(--text-2)" }}>{t("no_changes")}</span>
        )}
      </div>

      <div style={{ fontSize: 12, color: "var(--text-3)" }}>{comparedLine}</div>

      {hasChanges && (
        <div style={{ marginTop: 8 }}>
          <button
            aria-expanded={showDetails}
            onClick={() => setShowDetails((v) => !v)}
            style={{
              all: "unset",
              cursor: "pointer",
              fontSize: 12,
              color: "var(--accent, #2563eb)",
              textDecoration: "underline dotted",
            }}
            type="button"
          >
            {showDetails ? `${t("hide_details")} ▲` : `${t("show_details")} ▾`}
          </button>
          {showDetails && (
            <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
              {data.changes.map((change: ChangeEntry, i: number) => (
                <div
                  className="timeline-change"
                  key={i}
                  style={{ display: "flex", gap: 8, alignItems: "flex-start" }}
                >
                  <span
                    aria-hidden="true"
                    className={`timeline-change-icon ${change.type}`}
                  >
                    {change.type === "added"
                      ? "＋"
                      : change.type === "removed"
                        ? "−"
                        : "~"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                    {change.description}
                    {change.details && change.details.length > 0 && (
                      <div
                        style={{
                          color: "var(--text-3)",
                          fontSize: 11,
                          marginTop: 2,
                        }}
                      >
                        {change.details.join(", ")}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
