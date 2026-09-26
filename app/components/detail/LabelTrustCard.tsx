"use client";

/**
 * "How much to trust this label" — sits at the top of the Privacy Labels
 * tab and tells the reader how much weight to give the self-declared label
 * underneath it. Every row is a finding from Alsahdi et al., "Why App
 * Developers Do (Not) Update Apple's Privacy Labels" (PoPETs 2026),
 * applied to THIS app from data the detail page already holds:
 *
 *   - label age, from the timeline rows (`changelog` + older pages fetched
 *     here on demand when the loaded page shows no change);
 *   - whether the label is "Data Not Collected", the label the study found
 *     least reliable;
 *   - the stored AI policy lens ratings, cross-checked against the label;
 *   - the price + IAP columns, as a proxy for ad and analytics SDKs.
 *
 * The derivation is `lib/label-trust.ts`; this file only fetches, formats
 * and renders. Gated by `flag.detail.labels.trust_card`, which the Monitor
 * goal turns on and the Minimal strip turns off; the view mounts it only
 * when the app has a label at all.
 *
 * Tone is the whole point. The study's conclusion is that the gap between
 * label and practice is mostly uncertainty about third-party SDKs and
 * organisational drift, not intent, and that neither the label nor the
 * policy is the truth. Every row says "worth a look", never "caught". Colour
 * marks the tone of a row but never carries it alone: each row has a glyph
 * and a title that read the same in monochrome (WCAG 1.4.1).
 */

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import type {
  ChangelogRow,
  SnapshotChangelogRow,
} from "../../../lib/changelog-types";
import { formatDate as formatDateWithMode } from "../../../lib/date-format";
import { useDateFormat } from "../../../lib/date-format-hook";
import {
  deriveLabelTrust,
  LABEL_TRUST_RESEARCH_URL,
  type LabelTrustReport,
} from "../../../lib/label-trust";
import type { App } from "./types";
import "./label-trust-card.css";

/** Rows per older-history page; the route caps at 200. */
const PAGE_LIMIT = 200;
/**
 * How far back to walk a run of no-change syncs before settling for
 * "unchanged across the last N syncs". 10 pages is 2,000 rows, over five
 * years of daily syncs; a label that has not changed in that long is
 * described accurately either way.
 */
const MAX_PAGES = 10;

interface OlderPage {
  hasMore: boolean;
  rows: ChangelogRow[];
}

type Tone = "watch" | "note" | "ok";

interface Row {
  action?: { label: string; onClick: () => void };
  body: string;
  key: string;
  title: string;
  tone: Tone;
}

const TONE_GLYPH: Record<Tone, string> = {
  watch: "⚠",
  note: "ℹ",
  ok: "✓",
};

export default function LabelTrustCard({
  app,
  changelog,
  changelogHasMore,
  onOpenHistory,
  onOpenPolicy,
}: {
  app: App;
  changelog: ChangelogRow[];
  changelogHasMore: boolean;
  /** Switches to the Change History tab. Omit to render no such action. */
  onOpenHistory?: () => void;
  /** Switches to the AI Policy tab. Omit when that tab is not available. */
  onOpenPolicy?: () => void;
}) {
  const t = useTranslations("label_trust");
  const tLens = useTranslations("policy_lens");
  const format = useFormatter();
  const dateMode = useDateFormat();

  // Older timeline pages, fetched only while the rows on hand show no label
  // change and the server says more exist. Reset when the app changes.
  const [older, setOlder] = useState<{
    appId: string;
    exhausted: boolean;
    hasMore: boolean;
    pages: number;
    rows: SnapshotChangelogRow[];
  }>({
    appId: app.id,
    exhausted: false,
    hasMore: changelogHasMore,
    pages: 0,
    rows: [],
  });
  const olderForThisApp = older.appId === app.id ? older : null;

  const allRows = useMemo<ChangelogRow[]>(
    () => [...changelog, ...(olderForThisApp?.rows ?? [])],
    [changelog, olderForThisApp]
  );
  const hasMore = olderForThisApp ? olderForThisApp.hasMore : changelogHasMore;

  const report = useMemo<LabelTrustReport>(
    () =>
      deriveLabelTrust({
        privacyTypes: app.privacyTypes,
        changelog: allRows,
        changelogHasMore: hasMore,
        policyAnalysis: app.policyAnalysis,
        priceAmount: app.priceAmount,
        hasIap: app.hasIap,
      }),
    [
      app.privacyTypes,
      app.policyAnalysis,
      app.priceAmount,
      app.hasIap,
      allRows,
      hasMore,
    ]
  );

  const age = report.age;
  const needsOlderPage =
    age.kind === "incomplete" &&
    olderForThisApp !== null &&
    !olderForThisApp.exhausted &&
    olderForThisApp.pages < MAX_PAGES;
  const nextBefore = age.kind === "incomplete" ? age.oldestInspected : null;

  useEffect(() => {
    if (olderForThisApp === null) {
      setOlder({
        appId: app.id,
        exhausted: false,
        hasMore: changelogHasMore,
        pages: 0,
        rows: [],
      });
    }
  }, [app.id, changelogHasMore, olderForThisApp]);

  useEffect(() => {
    if (!needsOlderPage || nextBefore === null) {
      return;
    }
    let cancelled = false;
    const url = `/api/apps/${encodeURIComponent(app.id)}/changelog?before=${nextBefore}&limit=${PAGE_LIMIT}`;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`);
        }
        return (await res.json()) as OlderPage;
      })
      .then((page) => {
        if (cancelled) {
          return;
        }
        const snapshots = page.rows.filter(
          (row): row is SnapshotChangelogRow => row.kind === "snapshot"
        );
        setOlder((prev) =>
          prev.appId === app.id
            ? {
                ...prev,
                rows: [...prev.rows, ...snapshots],
                pages: prev.pages + 1,
                // An empty page with hasMore still set would loop forever
                // on the same `before`; treat it as the end.
                hasMore: page.hasMore && page.rows.length > 0,
              }
            : prev
        );
      })
      .catch(() => {
        if (!cancelled) {
          setOlder((prev) =>
            prev.appId === app.id ? { ...prev, exhausted: true } : prev
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [app.id, needsOlderPage, nextBefore]);

  const formatDay = (ms: number) => formatDateWithMode(ms, dateMode);
  const rows: Row[] = [];

  // 1. The label the study trusts least.
  if (report.labelKind === "not_collected") {
    rows.push({
      key: "dnc",
      tone: "watch",
      title: t("dnc.title"),
      body: t("dnc.body"),
    });
  }

  // 2. Label age.
  const predates = (flag: boolean) =>
    flag ? ` ${t("age.predates_manifests")}` : "";
  if (age.kind === "changed") {
    rows.push({
      key: "age",
      tone: "ok",
      title: t("age.changed_title", { date: formatDay(age.at) }),
      body:
        t("age.changed_body") +
        (age.addedTracking ? ` ${t("age.added_tracking")}` : "") +
        predates(age.predatesManifests),
    });
  } else if (age.kind === "unchanged" && age.reachesArchive) {
    rows.push({
      key: "age",
      tone: "watch",
      title: t("age.unchanged_title", { date: formatDay(age.since) }),
      body: t("age.unchanged_body") + predates(age.predatesManifests),
    });
  } else if (age.kind === "unchanged") {
    rows.push({
      key: "age",
      tone: "note",
      title: t("age.since_tracking_title", { date: formatDay(age.since) }),
      body: t("age.since_tracking_body") + predates(age.predatesManifests),
      action: onOpenHistory
        ? { label: t("age.open_history"), onClick: onOpenHistory }
        : undefined,
    });
  } else if (age.kind === "incomplete") {
    const stillChecking = needsOlderPage;
    rows.push({
      key: "age",
      tone: "note",
      title: stillChecking
        ? t("age.checking_title")
        : t("age.recent_title", { count: age.rowsInspected }),
      body: stillChecking
        ? t("age.checking_body", { count: age.rowsInspected })
        : t("age.recent_body"),
    });
  }

  // 3. The second witness.
  const policy = report.policy;
  if (policy.kind === "mismatch") {
    rows.push({
      key: "policy",
      tone: "watch",
      title: t("policy.mismatch_title"),
      body: t("policy.mismatch_body", {
        lenses: format.list(policy.lenses.map((key) => tLens(key))),
      }),
      action: onOpenPolicy
        ? { label: t("policy.open_policy"), onClick: onOpenPolicy }
        : undefined,
    });
  } else if (policy.kind === "consistent") {
    rows.push({
      key: "policy",
      tone: "ok",
      title: t("policy.consistent_title"),
      body: t("policy.consistent_body"),
    });
  } else if (policy.kind === "no_summary") {
    rows.push({
      key: "policy",
      tone: "note",
      title: t("policy.no_summary_title"),
      body: t("policy.no_summary_body"),
      action: onOpenPolicy
        ? { label: t("policy.open_policy"), onClick: onOpenPolicy }
        : undefined,
    });
  } else {
    rows.push({
      key: "policy",
      tone: "note",
      title: t("policy.none_title"),
      body: t("policy.none_body"),
      action: onOpenPolicy
        ? { label: t("policy.open_policy"), onClick: onOpenPolicy }
        : undefined,
    });
  }

  // 4. What pays for the app.
  if (report.monetisation === "free_iap") {
    rows.push({
      key: "money",
      tone: "watch",
      title: t("money.free_iap_title"),
      body: t("money.free_iap_body"),
    });
  } else if (report.monetisation === "free") {
    rows.push({
      key: "money",
      tone: "note",
      title: t("money.free_title"),
      body: t("money.free_body"),
    });
  } else if (report.monetisation === "paid") {
    rows.push({
      key: "money",
      tone: "ok",
      title: t("money.paid_title"),
      body: t("money.paid_body"),
    });
  }

  return (
    <section
      aria-labelledby="label-trust-title"
      className="label-trust"
      data-flag-target="flag.detail.labels.trust_card"
    >
      <header className="label-trust-header">
        <span aria-hidden="true" className="label-trust-header-glyph">
          🔍
        </span>
        <h2 className="label-trust-title" id="label-trust-title">
          {t("title")}
        </h2>
      </header>
      <p className="label-trust-intro">{t("intro")}</p>
      <ul className="label-trust-rows">
        {rows.map((row) => (
          <li
            className={`label-trust-row label-trust-row--${row.tone}`}
            data-signal={row.key}
            key={row.key}
          >
            <span aria-hidden="true" className="label-trust-glyph">
              {TONE_GLYPH[row.tone]}
            </span>
            <div className="label-trust-row-main">
              <div className="label-trust-row-title">{row.title}</div>
              <p className="label-trust-row-body">{row.body}</p>
              {row.action && (
                <button
                  className="btn btn-ghost btn-sm label-trust-row-action"
                  onClick={row.action.onClick}
                  type="button"
                >
                  {row.action.label}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <footer className="label-trust-footer">
        <Link
          className="label-trust-footer-link"
          href="/help/definitions#label-trust"
        >
          {t("learn_more")}
        </Link>
        <a
          className="label-trust-footer-link"
          href={LABEL_TRUST_RESEARCH_URL}
          rel="noopener noreferrer"
          target="_blank"
        >
          {t("source_link")}
        </a>
      </footer>
    </section>
  );
}
