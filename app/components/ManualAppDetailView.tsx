"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { useFlag } from "../../lib/feature-flags-hooks";
import type {
  ManualAppEvent,
  ManualAppFieldChangeDetail,
  ManualAppPolicyVersion,
  ManualAppScrapeDetail,
} from "../../lib/manual-app-history";
import type { ManualApp, ManualAppSourceMeta } from "../../lib/manual-apps";
import Favicon from "./Favicon";

interface Props {
  app: ManualApp;
  currentVersion: ManualAppPolicyVersion | null;
  events: ManualAppEvent[];
  meta: ManualAppSourceMeta;
}

// Shape of POST /api/manual-apps/[id]/scrape response. Kept here so the
// component is the single point of contact with the endpoint.
interface ScrapeResponse {
  error?: string;
  event: ManualAppEvent;
  version: {
    id: string;
    contentHash: string;
    wordCount: number;
    policyUrl: string;
    sourceFinalUrl: string;
    sourceTitle: string;
    fetchedAt: number;
    isNew: boolean;
  } | null;
}

interface PolicyVersionResponse {
  version: ManualAppPolicyVersion;
}

function formatDateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function safeHost(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

type DetailT = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

/** Human label + icon for each scrape policy_event discriminator. */
function scrapeEventLabel(
  t: DetailT,
  event: ManualAppScrapeDetail
): { icon: string; title: string; tone: "ok" | "warn" | "error" | "info" } {
  switch (event.policy_event) {
    case "first":
      return { icon: "●", title: t("scrape_event_first"), tone: "info" };
    case "changed":
      return { icon: "△", title: t("scrape_event_changed"), tone: "warn" };
    case "same":
      return { icon: "✓", title: t("scrape_event_same"), tone: "ok" };
    case "error":
      return { icon: "✕", title: t("scrape_event_error"), tone: "error" };
    default:
      return { icon: "·", title: t("scrape_event_default"), tone: "info" };
  }
}

const FIELD_LABEL_KEYS: Record<ManualAppFieldChangeDetail["field"], string> = {
  name: "field_label_name",
  source: "field_label_source",
  developer: "field_label_developer",
  privacyPolicyUrl: "field_label_privacy_policy_url",
  sourceUrl: "field_label_source_url",
  notes: "field_label_notes",
};

function truncate(value: string | null, max = 160): string {
  if (!value) {
    return "—";
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max).trimEnd()}…`;
}

export default function ManualAppDetailView({
  app,
  meta,
  events,
  currentVersion,
}: Props) {
  // i18n — page chrome (breadcrumbs, header, action buttons, scrape
  // card, changelog). The source-meta short label still comes from
  // the shared `manual_app_source.*` namespace so the eyebrow chip
  // matches the picker buttons in ManualAppsView.
  const t = useTranslations("manual_app_detail");
  const tSource = useTranslations("manual_app_source");

  // Wave I — per-section flags for the manual-app surface. Each one
  // resolves through the same useFlag hook the rest of the client tree
  // uses, so override toggles in Dev Options re-render this view live.
  const manualScrapeButtonOn =
    useFlag("flag.detail.manual.scrape_button") === "on";
  const manualCurrentVersionMetadataOn =
    useFlag("flag.detail.manual.current_version_metadata") === "on";
  const manualShowCapturedTextOn =
    useFlag("flag.detail.manual.show_captured_text") === "on";
  const manualEditDetailsOn =
    useFlag("flag.detail.manual.edit_details") === "on";
  const manualChangelogOn = useFlag("flag.detail.manual.changelog") === "on";

  const [liveApp] = useState<ManualApp>(app);
  const [liveEvents, setLiveEvents] = useState<ManualAppEvent[]>(events);
  const [liveVersion, setLiveVersion] = useState<ManualAppPolicyVersion | null>(
    currentVersion
  );
  const [scraping, setScraping] = useState(false);
  const [flash, setFlash] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  // Lazy cache for expanded policy versions, keyed by version id. The
  // changelog starts collapsed; clicking "Show captured text" fires a GET
  // for the full text the first time and reuses the cache afterwards.
  const [expandedVersions, setExpandedVersions] = useState<
    Record<
      string,
      | { status: "loading" }
      | { status: "loaded"; version: ManualAppPolicyVersion }
      | { status: "error"; message: string }
    >
  >({});

  const policyHost = useMemo(
    () => safeHost(liveApp.privacyPolicyUrl),
    [liveApp.privacyPolicyUrl]
  );
  const sourceHost = useMemo(
    () => safeHost(liveApp.sourceUrl),
    [liveApp.sourceUrl]
  );
  const canScrape = Boolean(liveApp.privacyPolicyUrl) && !scraping;

  const onScrape = useCallback(async () => {
    if (!liveApp.privacyPolicyUrl || scraping) {
      return;
    }
    setScraping(true);
    setErrorMsg("");
    setFlash("");
    try {
      const res = await fetch(`/api/manual-apps/${liveApp.id}/scrape`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as ScrapeResponse & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data?.error ?? t("scrape_failed_default"));
      }

      // Prepend the new event so the user sees it at the top without a reload.
      if (data.event) {
        setLiveEvents((prev) => [data.event, ...prev]);
      }

      if (data.version) {
        // Synthesise a "current version" entry from the endpoint's lightweight
        // summary — sufficient for the summary card. The full text arrives
        // on-demand via the /policy-version/ GET when the user expands a row.
        setLiveVersion((prev) => ({
          id: data.version!.id,
          manualAppId: liveApp.id,
          contentHash: data.version!.contentHash,
          firstFetchedAt: data.version!.isNew
            ? data.version!.fetchedAt
            : (prev?.firstFetchedAt ?? data.version!.fetchedAt),
          lastFetchedAt: data.version!.fetchedAt,
          policyUrl: data.version!.policyUrl,
          sourceFinalUrl: data.version!.sourceFinalUrl,
          sourceTitle: data.version!.sourceTitle,
          sourceContentType: prev?.sourceContentType ?? null,
          sourceOrigin: prev?.sourceOrigin ?? null,
          sourceWordCount: data.version!.wordCount,
          sourceText:
            prev?.contentHash === data.version!.contentHash
              ? (prev?.sourceText ?? "")
              : "",
        }));
      }

      const scrapeDetail = data.event?.detail;
      if (scrapeDetail && scrapeDetail.kind === "scrape") {
        switch (scrapeDetail.policy_event) {
          case "first":
            setFlash(t("flash_first"));
            break;
          case "changed":
            setFlash(t("flash_changed"));
            break;
          case "same":
            setFlash(t("flash_same"));
            break;
          case "error":
            setErrorMsg(scrapeDetail.error ?? t("scrape_returned_error"));
            break;
        }
      } else if (data.error) {
        setErrorMsg(data.error);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : t("scrape_failed_default")
      );
    } finally {
      setScraping(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, [liveApp.id, liveApp.privacyPolicyUrl, scraping]);

  const toggleVersion = useCallback(
    async (versionId: string) => {
      const cached = expandedVersions[versionId];
      if (cached && cached.status === "loaded") {
        // Collapse on a second click by removing the key.
        setExpandedVersions((prev) => {
          const next = { ...prev };
          delete next[versionId];
          return next;
        });
        return;
      }
      setExpandedVersions((prev) => ({
        ...prev,
        [versionId]: { status: "loading" },
      }));
      try {
        const res = await fetch(
          `/api/manual-apps/${liveApp.id}/policy-version/${versionId}`
        );
        const data = (await res
          .json()
          .catch(() => ({}))) as PolicyVersionResponse & {
          error?: string;
        };
        if (!(res.ok && data?.version)) {
          throw new Error(data?.error ?? t("captured_text_load_failed"));
        }
        setExpandedVersions((prev) => ({
          ...prev,
          [versionId]: { status: "loaded", version: data.version },
        }));
      } catch (err) {
        setExpandedVersions((prev) => ({
          ...prev,
          [versionId]: {
            status: "error",
            message:
              err instanceof Error
                ? err.message
                : t("captured_text_load_failed"),
          },
        }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
    [expandedVersions, liveApp.id]
  );

  // Split events into scrape vs field_change groups in case we want to show
  // a scrape-only summary later. For now we render them in a unified feed
  // because interleaving "URL changed → re-scrape → content changed" tells
  // the fuller story.
  // Note: liveEvents is already ordered newest-first by the server.

  return (
    <main className="page manual-app-detail-page">
      <nav
        aria-label={t("breadcrumbs_aria")}
        className="manual-app-detail-breadcrumbs"
      >
        <Link href="/dashboard">{t("breadcrumb_dashboard")}</Link>
        <span aria-hidden="true"> › </span>
        <Link href="/dashboard/manual-apps">{t("breadcrumb_manual")}</Link>
        <span aria-hidden="true"> › </span>
        <span>{liveApp.name}</span>
      </nav>

      <header className="manual-app-detail-header">
        <div className="manual-app-detail-headline">
          <span aria-hidden="true" className="manual-app-detail-icon">
            {meta?.icon ?? "📦"}
          </span>
          <div>
            <div className="manual-app-detail-eyebrow">
              {meta ? tSource(`${meta.value}_label`) : liveApp.source}
            </div>
            <h1 className="manual-app-detail-title">{liveApp.name}</h1>
            <div className="manual-app-detail-sub">
              {liveApp.developer ? (
                <span>{liveApp.developer}</span>
              ) : (
                <span className="muted">{t("developer_unset")}</span>
              )}
              <span aria-hidden="true"> · </span>
              <span className="muted">
                {t("added_at", { date: formatDateTime(liveApp.firstSeen) })}
              </span>
            </div>
          </div>
        </div>

        <div className="manual-app-detail-actions">
          {manualEditDetailsOn && (
            <Link
              className="btn btn-secondary"
              href={`/dashboard/manual-apps?editId=${encodeURIComponent(liveApp.id)}`}
            >
              {t("edit_details")}
            </Link>
          )}
          <Link className="btn btn-ghost" href="/dashboard/manual-apps">
            {t("back_to_list")}
          </Link>
        </div>
      </header>

      <section className="manual-app-detail-facts">
        <dl>
          <div>
            <dt>{t("policy_label")}</dt>
            <dd>
              {liveApp.privacyPolicyUrl ? (
                <a
                  className="manual-app-detail-link"
                  href={liveApp.privacyPolicyUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  <Favicon size={16} url={liveApp.privacyPolicyUrl} />
                  <span>{policyHost ?? liveApp.privacyPolicyUrl}</span>
                </a>
              ) : (
                <span className="muted">{t("policy_unset")}</span>
              )}
            </dd>
          </div>
          {liveApp.sourceUrl && (
            <div>
              <dt>{t("source_link_label")}</dt>
              <dd>
                <a
                  className="manual-app-detail-link"
                  href={liveApp.sourceUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  <Favicon size={16} url={liveApp.sourceUrl} />
                  <span>{sourceHost ?? liveApp.sourceUrl}</span>
                </a>
              </dd>
            </div>
          )}
          {liveApp.notes && (
            <div className="manual-app-detail-notes">
              <dt>{t("notes_label")}</dt>
              <dd>{liveApp.notes}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="manual-app-detail-scrape-card">
        <div className="manual-app-detail-scrape-heading">
          <h2>{t("scrape_card_heading")}</h2>
          {manualScrapeButtonOn && (
            <button
              className="btn btn-primary"
              disabled={!canScrape}
              onClick={onScrape}
              type="button"
            >
              {scraping
                ? t("scraping")
                : liveVersion
                  ? t("rescrape_button")
                  : t("scrape_button")}
            </button>
          )}
        </div>

        {!liveApp.privacyPolicyUrl && (
          <p className="manual-app-detail-scrape-hint muted">
            {t.rich("scrape_hint_no_url", {
              editLink: (chunks) => (
                <Link
                  href={`/dashboard/manual-apps?editId=${encodeURIComponent(liveApp.id)}`}
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
        )}

        {flash && (
          <div className="manual-app-detail-flash" role="status">
            {flash}
          </div>
        )}
        {errorMsg && (
          <div className="manual-app-detail-error" role="alert">
            {errorMsg}
          </div>
        )}

        {liveVersion && manualCurrentVersionMetadataOn ? (
          <div className="manual-app-detail-current">
            <div className="manual-app-detail-current-row">
              <span className="manual-app-detail-current-label">
                {t("current_last_captured")}
              </span>
              <span>{formatDateTime(liveVersion.lastFetchedAt)}</span>
            </div>
            <div className="manual-app-detail-current-row">
              <span className="manual-app-detail-current-label">
                {t("current_first_captured")}
              </span>
              <span>{formatDateTime(liveVersion.firstFetchedAt)}</span>
            </div>
            <div className="manual-app-detail-current-row">
              <span className="manual-app-detail-current-label">
                {t("current_word_count")}
              </span>
              <span>{liveVersion.sourceWordCount.toLocaleString()}</span>
            </div>
            {liveVersion.sourceFinalUrl && (
              <div className="manual-app-detail-current-row">
                <span className="manual-app-detail-current-label">
                  {t("current_resolved_url")}
                </span>
                <span>
                  <a
                    href={liveVersion.sourceFinalUrl}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {safeHost(liveVersion.sourceFinalUrl) ??
                      liveVersion.sourceFinalUrl}
                  </a>
                </span>
              </div>
            )}
            {liveVersion.sourceTitle && (
              <div className="manual-app-detail-current-row">
                <span className="manual-app-detail-current-label">
                  {t("current_page_title")}
                </span>
                <span>{truncate(liveVersion.sourceTitle, 120)}</span>
              </div>
            )}
          </div>
        ) : (
          <p className="manual-app-detail-empty muted">
            {t.rich("no_captures", {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
        )}
      </section>

      {manualChangelogOn && (
        <section className="manual-app-detail-changelog">
          <h2>{t("changelog_heading")}</h2>
          <p className="muted manual-app-detail-changelog-intro">
            {t("changelog_intro")}
          </p>

          {liveEvents.length === 0 ? (
            <div className="manual-app-detail-empty">
              <p className="muted">{t("changelog_empty")}</p>
            </div>
          ) : (
            <ol
              aria-label={t("timeline_aria")}
              className="manual-app-detail-timeline"
            >
              {liveEvents.map((event) => (
                <ManualAppTimelineRow
                  event={event}
                  expanded={expandedVersions}
                  key={event.id}
                  onToggleVersion={toggleVersion}
                  showCapturedText={manualShowCapturedTextOn}
                />
              ))}
            </ol>
          )}
        </section>
      )}
    </main>
  );
}

interface TimelineRowProps {
  event: ManualAppEvent;
  expanded: Record<
    string,
    | { status: "loading" }
    | { status: "loaded"; version: ManualAppPolicyVersion }
    | { status: "error"; message: string }
  >;
  onToggleVersion: (versionId: string) => void;
  /** Wave I — `flag.detail.manual.show_captured_text`. */
  showCapturedText?: boolean;
}

function ManualAppTimelineRow({
  event,
  expanded,
  onToggleVersion,
  showCapturedText = true,
}: TimelineRowProps) {
  const tDetail = useTranslations("manual_app_detail");
  const when = formatDateTime(event.occurredAt);

  if (event.type === "scrape" && event.detail?.kind === "scrape") {
    const label = scrapeEventLabel(tDetail, event.detail);
    const versionId = event.detail.versionId;
    const expansion = versionId ? expanded[versionId] : undefined;
    const isExpanded = expansion?.status === "loaded";

    return (
      <li className={`manual-app-detail-timeline-row tone-${label.tone}`}>
        <div aria-hidden="true" className="manual-app-detail-timeline-icon">
          {label.icon}
        </div>
        <div className="manual-app-detail-timeline-body">
          <div className="manual-app-detail-timeline-heading">
            <span className="manual-app-detail-timeline-title">
              {label.title}
            </span>
            <span className="manual-app-detail-timeline-time">{when}</span>
          </div>
          <div className="manual-app-detail-timeline-meta">
            {typeof event.detail.wordCount === "number" && (
              <span>
                {tDetail("n_words", { count: event.detail.wordCount })}
              </span>
            )}
            {event.detail.finalUrl && (
              <>
                {typeof event.detail.wordCount === "number" && (
                  <span aria-hidden="true"> · </span>
                )}
                <a
                  href={event.detail.finalUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  {safeHost(event.detail.finalUrl) ?? event.detail.finalUrl}
                </a>
              </>
            )}
          </div>
          {event.detail.error && (
            <div className="manual-app-detail-timeline-error">
              {event.detail.error}
            </div>
          )}
          {showCapturedText && versionId && (
            <div className="manual-app-detail-timeline-actions">
              <button
                className="pill-button"
                onClick={() => onToggleVersion(versionId)}
                type="button"
              >
                {isExpanded
                  ? tDetail("hide_captured_text")
                  : tDetail("show_captured_text")}
              </button>
            </div>
          )}
          {expansion?.status === "loading" && (
            <div className="manual-app-detail-timeline-loading">
              {tDetail("loading_captured_text")}
            </div>
          )}
          {expansion?.status === "error" && (
            <div className="manual-app-detail-timeline-error">
              {expansion.message}
            </div>
          )}
          {expansion?.status === "loaded" && (
            <pre className="manual-app-detail-timeline-text">
              {expansion.version.sourceText}
            </pre>
          )}
        </div>
      </li>
    );
  }

  if (event.type === "field_change" && event.detail?.kind === "field_change") {
    const labelKey = FIELD_LABEL_KEYS[event.detail.field];
    const label = labelKey ? tDetail(labelKey) : event.detail.field;
    const from = truncate(event.detail.from, 160);
    const to = truncate(event.detail.to, 160);
    return (
      <li className="manual-app-detail-timeline-row tone-info">
        <div aria-hidden="true" className="manual-app-detail-timeline-icon">
          ✎
        </div>
        <div className="manual-app-detail-timeline-body">
          <div className="manual-app-detail-timeline-heading">
            <span className="manual-app-detail-timeline-title">
              {tDetail("field_updated", { label })}
            </span>
            <span className="manual-app-detail-timeline-time">{when}</span>
          </div>
          <div className="manual-app-detail-timeline-meta">
            <span className="manual-app-detail-timeline-diff">
              <span className="manual-app-detail-timeline-from">{from}</span>
              <span aria-hidden="true"> → </span>
              <span className="manual-app-detail-timeline-to">{to}</span>
            </span>
          </div>
        </div>
      </li>
    );
  }

  // Fallback for unknown event shapes (migration from a future schema).
  return (
    <li className="manual-app-detail-timeline-row tone-info">
      <div aria-hidden="true" className="manual-app-detail-timeline-icon">
        ·
      </div>
      <div className="manual-app-detail-timeline-body">
        <div className="manual-app-detail-timeline-heading">
          <span className="manual-app-detail-timeline-title">{event.type}</span>
          <span className="manual-app-detail-timeline-time">{when}</span>
        </div>
      </div>
    </li>
  );
}
