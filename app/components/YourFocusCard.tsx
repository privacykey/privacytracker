"use client";

/**
 * YourFocusCard — top-of-Settings card showing the user's current focus
 * (audience + goals + accessibility modifier) as chips, with an Adjust
 * button.
 *
 * Rust-core Phase 0: this was the last server component rendered by a
 * converted page (settings/you passed it as a slot), and the one escape
 * the shell ledger couldn't see — it read the DB directly for the
 * focus, seven flags, the annotation count and the date-format
 * preference. All four now come from the APIs: `GET /api/focus` (which
 * grew `updatedAt` for the footnote), `useFlagValues` (the tri-state
 * accessor — two of the "enables" flags are on/off/collapsed and
 * `collapsed` must count as on), `GET /api/annotations?countApps=1`
 * (gated exactly as before: loved_one audience AND the banner flag),
 * and `GET /api/date-format`.
 *
 * Renders nothing until focus, flags and the date mode have all
 * settled; each read degrades independently (flags → all-off enables,
 * date mode → default, count → 0), matching the server version's
 * per-read try/catch fallbacks.
 * See https://docs.privacytracker.privacykey.org/develop/feature-flags
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  DATE_FORMAT_DEFAULT,
  type DateFormatMode,
  formatDate,
} from "@/lib/date-format";
import type { Audience } from "@/lib/feature-flag-rules";
import { describePurpose } from "@/lib/onboarding-purpose";
import { useFlagValues } from "@/lib/use-flag-bundle";
import AccessibilityFigureGlyph from "./AccessibilityFigureGlyph";

const AUDIENCE_ICONS: Record<"self" | "loved_one" | "guardian", string> = {
  self: "👤",
  loved_one: "🤝",
  guardian: "🛡️",
};
// Accessibility isn't here — the modifier chip renders an
// `<AccessibilityFigureGlyph />` SVG instead of a single emoji.
const GOAL_ICONS: Record<string, string> = {
  monitor: "🔍",
  cleanup: "🧹",
  minimal: "📋",
};
// /welcome primary-purpose icons — shown in place of the goal chips when
// the focus maps to a single purpose card.
const PURPOSE_ICONS: Record<string, string> = {
  monitor: "🔍",
  cleanup: "🧹",
  help: "🧭",
};

const CARD_FLAG_KEYS = [
  "flag.dashboard.annotation_banner",
  "flag.page.privacy_map",
  "flag.page.stats",
  "flag.page.compare",
  "flag.page.shortlist",
  "flag.page.manual_apps",
  "flag.detail.annotations_sidebar",
  "flag.detail.a11y.panel",
] as const;

interface FocusPayload {
  accessibility: boolean;
  audience: Audience;
  audienceSet: boolean;
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
  updatedAt: number | null;
  workflow:
    | "self_monitor"
    | "self_cleanup"
    | "other_handoff"
    | "other_monitor"
    | "custom";
}

export default function YourFocusCard() {
  // Four translation namespaces: `your_focus_card` (card chrome),
  // `audience` (audience chip label), `focus_purpose` (the /welcome purpose
  // chip + accessibility label), `goal` (custom-focus fallback chips).
  const t = useTranslations("your_focus_card");
  const tAudience = useTranslations("audience");
  const tGoal = useTranslations("goal");
  const tPurpose = useTranslations("focus_purpose");

  const flagValues = useFlagValues(CARD_FLAG_KEYS);
  const [focusData, setFocusData] = useState<FocusPayload | null>(null);
  const [focusFailed, setFocusFailed] = useState(false);
  const [dateMode, setDateMode] = useState<DateFormatMode | null>(null);
  const [annotationCount, setAnnotationCount] = useState(0);

  useEffect(() => {
    let live = true;
    fetch("/api/focus")
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
      )
      .then((json: FocusPayload) => {
        if (live) {
          setFocusData(json);
        }
      })
      .catch((error) => {
        console.warn("[your-focus-card] focus load failed:", error);
        if (live) {
          setFocusFailed(true);
        }
      });
    fetch("/api/date-format")
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((json: { mode?: DateFormatMode } | null) => {
        if (live) {
          setDateMode(json?.mode ?? DATE_FORMAT_DEFAULT);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const isLovedOne = focusData?.audience === "loved_one";
  const annotationBannerOn =
    flagValues?.["flag.dashboard.annotation_banner"] === "on";

  // Same gate the server component applied before its COUNT query:
  // loved_one audience AND the banner flag. The count arriving after
  // first paint only ever ADDS the notes subtext, matching how the
  // card's data was already per-request fresh.
  useEffect(() => {
    if (!(isLovedOne && annotationBannerOn)) {
      return;
    }
    let live = true;
    fetch("/api/annotations?countApps=1")
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((json: { appsWithNotes?: number } | null) => {
        if (live && typeof json?.appsWithNotes === "number") {
          setAnnotationCount(json.appsWithNotes);
        }
      });
    return () => {
      live = false;
    };
  }, [isLovedOne, annotationBannerOn]);

  // Hold until every held-for input settles. A failed flag load still
  // resolves flagValues (empty map → all enables read as off, the same
  // fallback the server version's per-flag catch produced); a failed
  // focus load renders nothing — the card has no meaningful degraded
  // state without a focus, and Settings is fully usable without it.
  if (focusFailed) {
    return null;
  }
  if (!(focusData && flagValues && dateMode)) {
    return null;
  }

  const focus = {
    audience: focusData.audience,
    goals: new Set<string>(
      (
        [
          ["monitor", focusData.monitor],
          ["cleanup", focusData.cleanup],
          ["minimal", focusData.minimal],
          ["accessibility", focusData.accessibility],
        ] as const
      )
        .filter(([, on]) => on)
        .map(([goal]) => goal)
    ),
  };
  const audienceSet = focusData.audienceSet;

  // First-run / unset state — surface a setup CTA so users who land on
  // Settings without completing onboarding can self-recover.
  if (!audienceSet) {
    return (
      <section
        className="settings-section your-focus-card your-focus-card--unset"
        data-tour="focus-card"
        id="focus"
      >
        <h2 className="settings-section-title">{t("title")}</h2>
        <p className="your-focus-card__unset-subtext">{t("unset_subtext")}</p>
        <Link
          className="btn btn-primary your-focus-card__setup-cta"
          href="/onboard/welcome"
        >
          {t("unset_cta")}
        </Link>
      </section>
    );
  }

  // Set state — chip strip in audience · goals · modifier order.
  const audienceChip = tAudience(`${focus.audience}.label`);
  const goalChips = describeGoals(focus.goals, tGoal);
  const workflow = focusData.workflow;
  const accessibilityActive = focus.goals.has("accessibility");
  // Lead with the /welcome purpose (Monitor / Clean up / Help); fall back
  // to the goal chips for advanced combinations with no single purpose card.
  const purpose = describePurpose({
    audience: focus.audience,
    monitor: focus.goals.has("monitor"),
    cleanup: focus.goals.has("cleanup"),
    minimal: focus.goals.has("minimal"),
    accessibility: accessibilityActive,
    workflow,
  });

  // Plain-English summary combining audience + active goals. Subkeys live
  // under `your_focus_card.summary.*` for localiser-only edits.
  const summarySentences: string[] = [t(`summary.${focus.audience}`)];
  if (focus.goals.has("minimal")) {
    summarySentences.push(t("summary.with_minimal"));
  } else if (focus.goals.has("monitor") && focus.goals.has("cleanup")) {
    summarySentences.push(t("summary.with_monitor_cleanup"));
  } else if (focus.goals.has("monitor")) {
    summarySentences.push(t("summary.with_monitor"));
  } else if (focus.goals.has("cleanup")) {
    summarySentences.push(t("summary.with_cleanup"));
  }
  if (accessibilityActive) {
    summarySentences.push(t("summary.with_accessibility"));
  }
  if (workflow !== "custom") {
    summarySentences.push(t(`workflow.${workflow}`));
  }
  const summary = summarySentences.join(" ");

  // "What this turns on" — render a pill list of focus-controlled page
  // flags. For tri-state surfaces (collapsed/on/off) we treat non-'off'
  // as "on" because a collapsed panel is still mounted — which is why
  // these read through useFlagValues (raw values), not the boolean
  // bundle: `=== "on"` would misread the annotations sidebar's
  // "collapsed" hard-default as off. A key missing from the map (load
  // failure) reads as off, the same fallback the server version's
  // per-flag catch produced.
  const enables: ReadonlyArray<{
    key: string;
    flag: (typeof CARD_FLAG_KEYS)[number];
    treatCollapsedAsOn?: true;
  }> = [
    { key: "privacy_map", flag: "flag.page.privacy_map" },
    { key: "stats", flag: "flag.page.stats" },
    { key: "compare", flag: "flag.page.compare" },
    { key: "shortlist", flag: "flag.page.shortlist" },
    { key: "manual_apps", flag: "flag.page.manual_apps" },
    {
      key: "annotations",
      flag: "flag.detail.annotations_sidebar",
      treatCollapsedAsOn: true,
    },
    {
      key: "accessibility",
      flag: "flag.detail.a11y.panel",
      treatCollapsedAsOn: true,
    },
  ];
  const enableRows = enables.map(({ key, flag, treatCollapsedAsOn }) => {
    const value = flagValues[flag];
    const on =
      value === undefined
        ? false
        : treatCollapsedAsOn
          ? value !== "off"
          : value === "on";
    return { key, on };
  });

  // "Focus updated {date}" footnote — suppressed when the user has never
  // called setActiveFocus (e.g. DB-seeded installs).
  const updatedAt = focusData.updatedAt;

  return (
    <section
      className="settings-section your-focus-card"
      data-tour="focus-card"
      id="focus"
    >
      <header className="your-focus-card__header">
        <h2 className="settings-section-title">{t("title")}</h2>
        <Link
          aria-label={t("help_link")}
          className="your-focus-card__help-link"
          href="/help/focus"
          title={t("help_link")}
        >
          (?)
        </Link>
      </header>

      {/* Chip strip — audience + the /welcome purpose (Monitor / Clean up /
          Help), falling back to goal chips for custom focuses; accessibility
          renders an SVG figure-in-circle. */}
      <div className="your-focus-card__chips" role="list">
        <span className="chip chip--audience" role="listitem">
          <span aria-hidden="true" className="chip-icon">
            {AUDIENCE_ICONS[focus.audience]}
          </span>
          <span className="chip-label">{audienceChip}</span>
        </span>
        {purpose.isCustom ? (
          goalChips.map(({ key, label }) => (
            <span className="chip chip--goal" key={key} role="listitem">
              <span aria-hidden="true" className="chip-icon">
                {GOAL_ICONS[key] ?? ""}
              </span>
              <span className="chip-label">{label}</span>
            </span>
          ))
        ) : (
          <span className="chip chip--purpose" role="listitem">
            <span aria-hidden="true" className="chip-icon">
              {PURPOSE_ICONS[purpose.primary] ?? ""}
            </span>
            <span className="chip-label">
              {tPurpose(`primary.${purpose.primary}.title`)}
            </span>
          </span>
        )}
        {accessibilityActive && (
          <span className="chip chip--modifier" role="listitem">
            <span aria-hidden="true" className="chip-icon">
              <AccessibilityFigureGlyph size={16} />
            </span>
            <span className="chip-label">
              {tPurpose("secondary.accessibility.title")}
            </span>
          </span>
        )}
      </div>

      {summary && <p className="your-focus-card__summary">{summary}</p>}

      {isLovedOne && annotationCount > 0 && (
        <Link
          className="your-focus-card__annotation-count"
          href="/dashboard?filter=annotated"
        >
          {/* ICU plural via your_focus_card.annotation_count. */}
          {t("annotation_count", { count: annotationCount })}
        </Link>
      )}

      <div className="your-focus-card__enables">
        <h3 className="your-focus-card__enables-heading">
          {t("enables_heading")}
        </h3>
        <ul className="your-focus-card__enables-list">
          {enableRows.map((row) => (
            <li
              className={`your-focus-card__enable ${row.on ? "is-on" : "is-off"}`}
              key={row.key}
            >
              <span className="your-focus-card__enable-name">
                {t(`enables.${row.key}`)}
              </span>
              <span
                aria-hidden="true"
                className="your-focus-card__enable-state"
              >
                {row.on ? "●" : "○"}
              </span>
              <span className="your-focus-card__enable-state-label">
                {row.on ? t("enable_chip_on") : t("enable_chip_off")}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="your-focus-card__footer">
        <div className="your-focus-card__actions">
          <Link
            aria-label={t("adjust")}
            className="btn btn-primary your-focus-card__adjust"
            href="/dashboard/settings/focus"
          >
            <span aria-hidden="true" className="your-focus-card__adjust-icon">
              ✏️
            </span>
            <span>{t("adjust")}</span>
          </Link>
        </div>
        {updatedAt && (
          <p className="your-focus-card__updated-at">
            {t("updated_at", { date: formatDate(updatedAt, dateMode) })}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Render active goals as `{ key, label }` entries in display order:
 * monitor → cleanup (if both checked) → minimal. Accessibility is
 * rendered separately. Takes the goal-namespace `t` so this helper stays
 * sync (the caller already awaits translations once).
 */
function describeGoals(
  goals: Set<string>,
  tGoal: (key: string) => string
): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  if (goals.has("minimal")) {
    out.push({ key: "minimal", label: tGoal("minimal.label") });
  } else {
    if (goals.has("monitor")) {
      out.push({ key: "monitor", label: tGoal("monitor.label") });
    }
    if (goals.has("cleanup")) {
      out.push({ key: "cleanup", label: tGoal("cleanup.label") });
    }
  }
  return out;
}
