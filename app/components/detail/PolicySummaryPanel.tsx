"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  type AppPolicyAnalysis,
  POLICY_LENSES,
  POLICY_RATING_META,
  POLICY_SOURCE_ORIGIN_META,
  type PolicyRunPhase,
} from "../../../lib/policy-summary-meta";
import { isSafeExternalHref } from "../../../lib/safe-href";
import { useTaskCenter } from "../TaskCenter";
import AiSummaryDisclaimer from "./AiSummaryDisclaimer";
import { orderLensesBySeverity } from "./lens-ratings";
import PolicyChangeStrip from "./PolicyChangeStrip";
import PolicyChunkNotesBlock from "./PolicyChunkNotesBlock";
import PolicyFallbackReferences from "./PolicyFallbackReferences";
import PolicyPreviewBlock from "./PolicyPreviewBlock";
import PolicyRecentChangeBanner from "./PolicyRecentChangeBanner";
import PolicyRunLogStrip from "./PolicyRunLogStrip";
import type { App, RecentPolicyChangeHint } from "./types";

/**
 * Human-readable label for a PolicyRunPhase `phase` field. Used as the
 * TaskCenter subtitle while a regenerate is streaming so the background-task
 * tray shows which step the model is on ("Summarising…" vs "Chunking…")
 * instead of a lone spinner. Unknown phase names fall through to the raw
 * string so new phases added server-side still render something useful.
 */
type PhaseT = (key: string, values?: Record<string, string | number>) => string;
function describePolicyPhase(
  t: PhaseT,
  phase: string | undefined | null,
  note?: string
): string {
  if (!phase) {
    return t("working");
  }
  const base = (() => {
    switch (phase) {
      case "fetch":
        return t("fetch");
      case "parse":
        return t("parse");
      case "archive":
        return t("archive");
      case "summarise":
        return t("summarise");
      case "chunk":
        return t("chunk");
      case "chunk_summarise":
        return t("chunk_summarise");
      case "merge":
        return t("merge");
      case "persist":
        return t("persist");
      case "throttled":
        return t("throttled");
      case "same":
        return t("same");
      case "ready":
        return t("ready");
      default:
        return phase.replace(/_/g, " ");
    }
  })();
  // If the server supplied a short note (e.g. "chunk 3 of 7") surface it so
  // the user can tell progress is moving, not stuck.
  if (note) {
    return t("with_note", { base, note });
  }
  return t("with_ellipsis", { base });
}

/**
 * Hostname-only label for a URL (strips scheme, path, query, and leading
 * `www.`). Used in the Policy tab's metadata strip so "Fetched from …" pills
 * show `policies.google.com` rather than the whole `https://…/privacy` URL.
 * Returns '' for anything that can't be parsed as a URL so callers can just
 * truthy-check the result before rendering.
 */
function hostnameOf(url: string | undefined | null): string {
  if (typeof url !== "string" || !url.trim()) {
    return "";
  }
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

type StatusT = (
  key: string,
  values?: Record<string, string | number>
) => string;
function getPolicyStatusMessage(t: StatusT, analysis: AppPolicyAnalysis) {
  switch (analysis.status) {
    case "needs_ai_config":
      return t("status_needs_ai_config");
    case "source_ready":
      return t("status_source_ready");
    case "fetch_error":
      return analysis.summary
        ? t("status_fetch_error_with_summary")
        : t("status_fetch_error");
    case "unsupported_content_type":
      return t("status_unsupported_content_type");
    case "too_short":
      return t("status_too_short");
    case "analysis_error":
      return analysis.summary
        ? t("status_analysis_error_with_summary")
        : t("status_analysis_error");
    default:
      return analysis.error || t("analysis_unavailable");
  }
}

interface PolicyPanelFlagState {
  aiSummary: boolean;
  aiSummaryDisclaimer: boolean;
  changeStrip: boolean;
  chunkNotes: boolean;
  fallbackReferences: boolean;
  highlights: boolean;
  lensGrid: boolean;
  previewToggle: boolean;
  recentChangeBanner: boolean;
  rescrapeButton: boolean;
  rescrapeSummariseButton: boolean;
  runLogDetails: boolean;
  runLogStrip: boolean;
  safetySummary: boolean;
  sourcePolicyLink: boolean;
  summariseButton: boolean;
  waybackBackupLink: boolean;
  whatsNew: boolean;
}

export default function PolicySummaryPanel({
  app,
  formatDate,
  aiProvider,
  recentPolicyChange,
  policyDiffAlertDays,
  onViewDiff,
  flags,
  onRefresh,
}: {
  app: App;
  formatDate: (ts: number) => string;
  /** Parent's data refetch — see AppDetailView's prop of the same name. */
  onRefresh?: () => void;
  aiProvider: string;
  recentPolicyChange: RecentPolicyChangeHint | null;
  policyDiffAlertDays: number;
  /**
   * Called when the user clicks the "view diff" CTA in the banner. Wired
   * at the call-site to flip the tab state to 'changelog' (the diff
   * button on the timeline row then reveals the full render).
   */
  onViewDiff: () => void;
  /**
   * Wave I — per-section flag state. Each `flag.detail.policy.*` flag
   * threads through here as a boolean; missing flags fall back to true
   * so legacy callers stay rendering as before.
   */
  flags?: Partial<PolicyPanelFlagState>;
}) {
  // i18n for the AI policy panel section. Captured at the top so the
  // section title `<h2>` below can read from `app_detail.policy.*`.
  // The lens labels and rating badges read from their own shared
  // namespaces (`policy_lens.*`, `policy_rating.*`) so a copy edit on
  // the rating vocabulary ripples to every surface that renders it.
  const tDetail = useTranslations("app_detail");
  const tLens = useTranslations("policy_lens");
  const tRating = useTranslations("policy_rating");
  const tPolicyPhase = useTranslations("app_detail.policy_phase");
  const tPolicyRun = useTranslations("app_detail.policy_run");
  const tStatusMsg = useTranslations("app_detail.policy_meta");
  // Fold defaults so every gate reads as a clean boolean below.
  const pf: PolicyPanelFlagState = {
    aiSummary: flags?.aiSummary ?? true,
    aiSummaryDisclaimer: flags?.aiSummaryDisclaimer ?? true,
    highlights: flags?.highlights ?? true,
    lensGrid: flags?.lensGrid ?? true,
    safetySummary: flags?.safetySummary ?? true,
    whatsNew: flags?.whatsNew ?? true,
    recentChangeBanner: flags?.recentChangeBanner ?? true,
    changeStrip: flags?.changeStrip ?? true,
    chunkNotes: flags?.chunkNotes ?? true,
    runLogStrip: flags?.runLogStrip ?? true,
    runLogDetails: flags?.runLogDetails ?? true,
    fallbackReferences: flags?.fallbackReferences ?? true,
    waybackBackupLink: flags?.waybackBackupLink ?? true,
    sourcePolicyLink: flags?.sourcePolicyLink ?? true,
    rescrapeButton: flags?.rescrapeButton ?? true,
    summariseButton: flags?.summariseButton ?? true,
    rescrapeSummariseButton: flags?.rescrapeSummariseButton ?? true,
    previewToggle: flags?.previewToggle ?? true,
  };
  const [analysis, setAnalysis] = useState<
    AppPolicyAnalysis | null | undefined
  >(app.policyAnalysis);
  const [runningPhase, setRunningPhase] = useState<
    "idle" | "fetch" | "summarise" | "all"
  >("idle");
  const [regenError, setRegenError] = useState<string>("");
  // Live phase log for the currently running action — cleared when a new run
  // starts. On hover the user gets the full trace; the panel surface shows the
  // most recent entry as an "in-progress" indicator.
  const [liveLog, setLiveLog] = useState<PolicyRunPhase[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const taskCenter = useTaskCenter();
  // Used after a rescrape lands (success OR failure) to force Next to re-run
  // the parent server component so `changelog` reflects the newly-appended
  // privacy_snapshots row. Without this, the History tab only updates on a
  // full page reload, which made rescrape events look ephemeral.
  const router = useRouter();
  const refresh = onRefresh ?? (() => router.refresh());

  // `regenerating` drives the UI "in-flight" styling (disabled buttons,
  // spinner chip, "Thinking…" strip). We treat a server-reported
  // runStatus === 'running' exactly the same as a locally-driven run so the
  // user sees a consistent indicator regardless of which tab kicked it off.
  const regenerating =
    runningPhase !== "idle" || analysis?.runStatus === "running";

  const runPhase = async (phase: "fetch" | "summarise" | "all") => {
    if (runningPhase !== "idle") {
      return;
    }
    setRunningPhase(phase);
    setRegenError("");
    setLiveLog([]);

    const controller = new AbortController();
    const handle = taskCenter.startTask({
      title:
        phase === "fetch"
          ? tPolicyRun("title_fetch")
          : phase === "summarise"
            ? tPolicyRun("title_summarise")
            : tPolicyRun("title_regenerate"),
      subtitle: app.name,
      kind: "policy",
      href: `/apps/${app.id}`,
      onCancel: () => controller.abort(),
    });

    try {
      const res = await fetch("/api/policy/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: app.id, phase, stream: true }),
        signal: controller.signal,
      });

      if (!(res.ok && res.body)) {
        const fallback = await res.text().catch(() => "");
        const msg =
          fallback || tPolicyRun("regen_failed_status", { status: res.status });
        setRegenError(msg);
        handle.complete("error", msg);
        return;
      }

      // Stream NDJSON. Each line is either {type:'phase', phase:{...}},
      // {type:'done', analysis} or {type:'error', error}.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalAnalysis: AppPolicyAnalysis | null = null;
      let errorMessage = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          try {
            const payload = JSON.parse(trimmed);
            if (payload.type === "phase" && payload.phase) {
              const phaseEvent = payload.phase as PolicyRunPhase;
              // The server streams two events per phase: a start marker with
              // no `ms`, and an end marker with `ms` + optional error/note.
              // Merge by `at` so we render one log row per phase that
              // transitions from "in-progress" to "done" in place.
              setLiveLog((prev) => {
                const idx = prev.findIndex(
                  (p) => p.phase === phaseEvent.phase && p.at === phaseEvent.at
                );
                if (idx === -1) {
                  return [...prev, phaseEvent];
                }
                const next = prev.slice();
                next[idx] = phaseEvent;
                return next;
              });
              // Surface the current phase in the TaskCenter background tray
              // so "click the background task to view" actually tells the
              // user where the run is up to, instead of just spinning.
              handle.update({
                subtitle: tPolicyRun("subtitle_with_phase", {
                  name: app.name,
                  phase: describePolicyPhase(
                    tPolicyPhase,
                    phaseEvent.phase,
                    phaseEvent.note
                  ),
                }),
              });
            } else if (payload.type === "done") {
              finalAnalysis = (payload.analysis ??
                null) as AppPolicyAnalysis | null;
            } else if (payload.type === "error") {
              errorMessage =
                typeof payload.error === "string"
                  ? payload.error
                  : tPolicyRun("regen_failed");
            }
          } catch {
            // Swallow malformed line — we'll surface server-side errors via the 'error' payload.
          }
        }
      }

      if (errorMessage) {
        setRegenError(errorMessage);
        handle.complete("error", errorMessage);
      } else if (finalAnalysis) {
        // Server hydrates the analysis before the finally block flips
        // run_status back to 'idle', so the payload still reads 'running'.
        // Overwrite locally so the resume-polling useEffect doesn't fire a
        // redundant tick after the stream we were already consuming.
        setAnalysis({ ...finalAnalysis, runStatus: "idle" });
        handle.complete(
          "done",
          phase === "fetch"
            ? tPolicyRun("completion_fetch")
            : tPolicyRun("completion_summarise")
        );
      } else {
        const msg = tPolicyRun("regen_no_analysis");
        setRegenError(msg);
        handle.complete("error", msg);
      }
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        // Task Center marks it cancelled — no additional handle.complete call.
      } else {
        console.error(
          `[app-detail] Policy ${phase} failed for ${app.name}:`,
          error
        );
        const msg =
          error instanceof Error ? error.message : tPolicyRun("regen_failed");
        setRegenError(msg);
        handle.complete("error", msg);
      }
    } finally {
      setRunningPhase("idle");
      // Every rescrape path — success, unusable source, or fetch error —
      // appends a privacy_snapshots row server-side. Re-render the parent
      // server component so the Change History tab shows the new point
      // without the user having to manually refresh the page.
      refresh();
    }
  };

  // Resume-mid-run polling: when a summarise was kicked off from a different
  // tab (or before a page reload), the server carries a `runStatus: 'running'`
  // flag on the hydrated analysis. This effect watches for that flag and
  // polls /api/policy/status/[id] every 2s, mirroring the phase log into the
  // local liveLog state so the UI still shows "where it's up to" even
  // without the original NDJSON stream. We skip polling when runningPhase is
  // already non-idle because the streaming consumer is the source of truth
  // for in-flight runs *this tab* started.
  useEffect(() => {
    if (runningPhase !== "idle") {
      return;
    }
    if (analysis?.runStatus !== "running") {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) {
        return;
      }
      try {
        const res = await fetch(`/api/policy/status/${app.id}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(`status HTTP ${res.status}`);
        }
        const body = await res.json();
        if (cancelled) {
          return;
        }

        // Replace the log wholesale — the server's last_run_log is the
        // authoritative phase list, so we don't need to worry about merging
        // out-of-order updates.
        if (Array.isArray(body.lastRunLog)) {
          setLiveLog(body.lastRunLog as PolicyRunPhase[]);
        }

        if (body.runStatus !== "running") {
          // Run is done — fetch the fresh full analysis so all the panels
          // (summary, metadata pills, chunk notes) reflect the result.
          // router.refresh() reruns the parent server component which
          // re-hydrates `app.policyAnalysis` through the normal path.
          cancelled = true;
          refresh();
          return;
        }
      } catch {
        // Network blip — try again next tick. Don't log to avoid noise
        // during short offline moments; the persisted state is still
        // accurate once the next poll succeeds.
      }
      if (!cancelled) {
        timer = setTimeout(tick, 2000);
      }
    };

    // Kick off immediately so the user sees progress on first render rather
    // than after a 2s delay.
    tick();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [app.id, analysis?.runStatus, runningPhase, router]);

  const originMeta = analysis?.sourceOrigin
    ? POLICY_SOURCE_ORIGIN_META[analysis.sourceOrigin]
    : null;
  const hasPolicyUrl = Boolean(app.privacyPolicyUrl);
  const hasStoredSource = Boolean(
    analysis &&
      (analysis.status === "ready" ||
        analysis.status === "source_ready" ||
        analysis.status === "needs_ai_config" ||
        (analysis.sourceLength ?? 0) > 0)
  );
  const showRegenerateBelowFailure = Boolean(
    analysis &&
      analysis.status !== "ready" &&
      analysis.status !== "needs_ai_config"
  );

  const metadata: Array<{
    key: string;
    label: string;
    hint?: string;
    cls?: string;
  }> = [];
  if (analysis?.sourceTitle) {
    metadata.push({ key: "title", label: analysis.sourceTitle });
  }

  // Hostname-only attribution. Prefer the final URL we ended up on (after
  // redirects + the consent-wall bypass) — that's where the text *actually*
  // came from, which may differ from the Apple-supplied policy URL if the
  // developer hosts a wrapper page that redirects elsewhere (Google → YouTube
  // both link to policies.google.com, for example).
  const fetchedFromUrl = analysis?.sourceFinalUrl || app.privacyPolicyUrl || "";
  const fetchedFromHost = hostnameOf(fetchedFromUrl);
  const originalHost = hostnameOf(app.privacyPolicyUrl || "");
  if (fetchedFromHost) {
    const hostLabel =
      originalHost && fetchedFromHost !== originalHost
        ? tDetail("policy_meta.fetched_from_was", {
            host: fetchedFromHost,
            original: originalHost,
          })
        : tDetail("policy_meta.fetched_from", { host: fetchedFromHost });
    metadata.push({
      key: "host",
      label: hostLabel,
      hint: analysis?.sourceFinalUrl ?? app.privacyPolicyUrl,
      cls: "policy-meta-host",
    });
  }

  if (analysis?.sourceWordCount) {
    metadata.push({
      key: "words",
      label: tDetail("policy_meta.word_count", {
        count: analysis.sourceWordCount.toLocaleString(),
      }),
    });
  }
  if (originMeta && analysis?.sourceOrigin) {
    // `originMeta` is non-null only for known origins, so the dynamic
    // `policy_meta.origin_*` key below always resolves; the English
    // POLICY_SOURCE_ORIGIN_META labels stay as documentation + fallback
    // for plain-text (non-React) composers.
    metadata.push({
      key: "origin",
      label: tDetail(`policy_meta.origin_${analysis.sourceOrigin}`),
      hint: tDetail(`policy_meta.origin_${analysis.sourceOrigin}_hint`),
      cls: `policy-meta-origin policy-meta-origin-${analysis.sourceOrigin}`,
    });
  }
  if (analysis?.model) {
    metadata.push({
      key: "model",
      label: tDetail("policy_meta.model", { model: analysis.model }),
      cls: "policy-meta-model",
    });
  }
  if (analysis?.sourceFetchedAt) {
    metadata.push({
      key: "fetched",
      label: tDetail("policy_meta.policy_fetched", {
        date: formatDate(analysis.sourceFetchedAt),
      }),
    });
  }
  if (analysis?.updatedAt) {
    metadata.push({
      key: "analysed",
      label: tDetail("policy_meta.summary_updated", {
        date: formatDate(analysis.updatedAt),
      }),
    });
  }

  const persistedLog = analysis?.lastRunLog ?? [];
  const displayLog =
    runningPhase !== "idle" || liveLog.length > 0 ? liveLog : persistedLog;

  return (
    <section className="glass-card policy-summary-panel">
      <div className="policy-summary-header">
        <div>
          <div className="policy-summary-kicker">
            {tDetail("policy_kicker")}
          </div>
          <h2 className="policy-summary-title">
            {tDetail("policy.section_title")}
          </h2>
        </div>
        <p className="policy-summary-disclaimer">
          {tDetail("policy_fetch_scope_note")}
        </p>
      </div>

      <div className="policy-summary-meta">
        {metadata.map((item) => (
          <span
            className={`policy-meta-pill ${item.cls ?? ""}`.trim()}
            key={item.key}
            title={item.hint}
          >
            {item.label}
          </span>
        ))}
        {pf.sourcePolicyLink && isSafeExternalHref(app.privacyPolicyUrl) && (
          <a
            className="policy-meta-pill policy-meta-link"
            href={app.privacyPolicyUrl!}
            rel="noopener noreferrer"
            target="_blank"
          >
            {tDetail("policy_meta.open_source_policy")}
          </a>
        )}
        {pf.waybackBackupLink &&
          analysis?.archiveUrl &&
          isSafeExternalHref(analysis.archiveUrl) && (
            <a
              className="policy-meta-pill policy-meta-link"
              href={analysis.archiveUrl}
              rel="noopener noreferrer"
              target="_blank"
              title={tDetail("tooltips.open_archive_snapshot")}
            >
              {tDetail("policy_meta.wayback_backup")}
            </a>
          )}
      </div>

      {pf.recentChangeBanner && (
        <PolicyRecentChangeBanner
          formatDate={formatDate}
          onViewDiff={onViewDiff}
          policyDiffAlertDays={policyDiffAlertDays}
          recentPolicyChange={recentPolicyChange}
        />
      )}

      {hasPolicyUrl && (
        <div
          className="policy-action-row"
          style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}
        >
          {pf.rescrapeButton && (
            <button
              className="btn btn-secondary btn-sm"
              disabled={regenerating}
              onClick={() => runPhase("fetch")}
              title={tDetail("tooltips.refetch_policy_text")}
              type="button"
            >
              {runningPhase === "fetch" ? (
                <>
                  <span className="spinner" /> {tDetail("policy_rescraping")}
                </>
              ) : (
                tDetail("policy_rescrape")
              )}
            </button>
          )}
          {pf.summariseButton && (
            <button
              className="btn btn-secondary btn-sm"
              disabled={
                regenerating || !hasStoredSource || aiProvider === "disabled"
              }
              onClick={() => runPhase("summarise")}
              title={
                aiProvider === "disabled"
                  ? tDetail("policy_meta.title_summarise_disabled")
                  : hasStoredSource
                    ? tDetail("policy_meta.title_summarise_ready")
                    : tDetail("policy_meta.title_summarise_no_source")
              }
              type="button"
            >
              {runningPhase === "summarise" ? (
                <>
                  <span className="spinner" /> {tDetail("policy_summarising")}
                </>
              ) : (
                tDetail("policy_summarise")
              )}
            </button>
          )}
          {pf.rescrapeSummariseButton && (
            <button
              className="btn btn-primary btn-sm"
              disabled={regenerating || aiProvider === "disabled"}
              onClick={() => runPhase("all")}
              title={
                aiProvider === "disabled"
                  ? tDetail("policy_meta.title_summarise_disabled")
                  : tDetail("policy_meta.title_regen_one_pass")
              }
              type="button"
            >
              {runningPhase === "all" ? (
                <>
                  <span className="spinner" /> {tDetail("policy_regenerating")}
                </>
              ) : (
                tDetail("policy_regenerate")
              )}
            </button>
          )}
          {pf.previewToggle && hasStoredSource && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setShowPreview((v) => !v)}
              title={tDetail("tooltips.inspect_policy_text")}
              type="button"
            >
              {showPreview
                ? tDetail("policy_meta.preview_hide")
                : tDetail("policy_meta.preview_show")}
            </button>
          )}
        </div>
      )}

      {hasPolicyUrl && (
        <p className="policy-summary-note" role="note">
          <strong>{tDetail("policy_heads_up_lead")}</strong>
          {tDetail.rich("policy_heads_up_body", {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
      )}

      {/* Live phase / thinking strip. During a run we stream; otherwise we
          fall back to the last persisted run log so the user can still see
          what happened on the previous click. */}
      {pf.runLogStrip && (
        <PolicyRunLogStrip
          log={displayLog}
          regenError={regenError}
          running={runningPhase !== "idle"}
          showDetails={pf.runLogDetails}
        />
      )}

      {regenError && (
        <div className="policy-summary-empty policy-summary-error">
          {regenError}
        </div>
      )}

      {!app.privacyPolicyUrl && (
        <div className="policy-summary-empty">
          {tDetail("policy_no_link_empty")}
        </div>
      )}

      {app.privacyPolicyUrl && !analysis && (
        <div className="policy-summary-empty">
          {tDetail.rich("policy_no_analysis", {
            b: (chunks) => <strong>{chunks}</strong>,
          })}
        </div>
      )}

      {showPreview && hasStoredSource && analysis?.sourcePreview && (
        <PolicyPreviewBlock
          preview={analysis.sourcePreview}
          totalLength={analysis.sourceLength ?? analysis.sourcePreview.length}
        />
      )}

      {pf.chunkNotes &&
        analysis?.chunkNotes &&
        analysis.chunkNotes.length > 0 && (
          <PolicyChunkNotesBlock notes={analysis.chunkNotes} />
        )}

      {app.privacyPolicyUrl && analysis && !analysis.summary && (
        <div className="policy-summary-empty">
          <div>{getPolicyStatusMessage(tStatusMsg, analysis)}</div>
          {analysis.error &&
            analysis.error !== getPolicyStatusMessage(tStatusMsg, analysis) && (
              <div className="policy-summary-error-detail">
                {analysis.error}
              </div>
            )}
          {showRegenerateBelowFailure && (
            <button
              className="btn btn-secondary btn-sm"
              disabled={regenerating}
              onClick={() => runPhase("all")}
              style={{ marginTop: 12 }}
              type="button"
            >
              {regenerating
                ? tDetail("policy_meta.retrying")
                : tDetail("policy_meta.retry_analysis")}
            </button>
          )}
        </div>
      )}

      {analysis?.summary && (
        <>
          {pf.aiSummaryDisclaimer && (
            <AiSummaryDisclaimer
              archiveUrl={analysis.archiveUrl}
              policyUrl={app.privacyPolicyUrl}
            />
          )}

          {/*
            Wave I — `flag.detail.policy.safety_summary`. Surfaces the
            guardian-tuned 1-paragraph safety verdict + 3-5 minor-
            specific concerns from the model when the prompt produced
            them (only happens when audience === 'guardian'). The
            field is optional on the schema (older summaries don't
            carry it) so we render nothing when the model didn't
            emit one. The structured shape — `{ paragraph, concerns }`
            — is enforced by `lib/policy-summary-meta.ts` and the
            `finalSummarySchema()` JSON-schema in `lib/privacy-policy.ts`.
          */}
          {pf.safetySummary && analysis.summary.safetySummary && (
            <section
              aria-labelledby="policy-safety-summary-heading"
              className="policy-safety-summary"
              role="note"
            >
              <h3
                className="policy-safety-summary__heading"
                id="policy-safety-summary-heading"
              >
                <span aria-hidden="true">🛡</span>{" "}
                {tDetail("policy_safety_heading")}
              </h3>
              <p className="policy-safety-summary__paragraph">
                {analysis.summary.safetySummary.paragraph}
              </p>
              {analysis.summary.safetySummary.concerns.length > 0 && (
                <ul className="policy-safety-summary__concerns">
                  {analysis.summary.safetySummary.concerns.map(
                    (concern, idx) => (
                      <li key={idx}>{concern}</li>
                    )
                  )}
                </ul>
              )}
            </section>
          )}

          {pf.aiSummary && (
            <p className="policy-summary-overview">
              {analysis.summary.overview}
            </p>
          )}

          {pf.highlights && (
            <div className="policy-highlight-list">
              {analysis.summary.highlights.map((highlight) => (
                <div className="policy-highlight-pill" key={highlight}>
                  {highlight}
                </div>
              ))}
            </div>
          )}

          {/*
            The auto-matched PrivacySpy/ToS;DR reference card used to render
            here, driven by summary.externalReferences. It was removed after
            the match-by-name logic produced false positives (e.g. `myID` →
            T-Mobile). Stored rows may still carry the field from older runs
            — we simply don't render it. The always-visible fallback block
            lower in the panel still deep-links both registries' search
            pages for the same brand.
          */}

          {pf.changeStrip && analysis.previousSummary && (
            <PolicyChangeStrip
              current={analysis.summary}
              formatDate={formatDate}
              previous={analysis.previousSummary}
              previousAt={analysis.previousSummaryAt}
            />
          )}

          {pf.lensGrid && (
            <div className="policy-lens-grid">
              {orderLensesBySeverity(analysis.summary.lenses).map((entry) => {
                const lens = POLICY_LENSES.find((l) => l.key === entry.key);
                if (!lens) {
                  return null;
                }
                const meta = POLICY_RATING_META[entry.rating];

                return (
                  <div
                    className={`policy-lens-card policy-lens-card-${entry.rating}`}
                    data-rating={entry.rating}
                    key={lens.key}
                  >
                    <div className="policy-lens-top">
                      <span className="policy-lens-label">
                        {tLens(lens.key)}
                      </span>
                      <span className={`policy-rating-badge ${meta.cls}`}>
                        {tRating(entry.rating)}
                      </span>
                    </div>
                    <p className="policy-lens-copy">
                      {entry.summary || tDetail("policy_lens_no_address")}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {analysis.status !== "ready" && (
            <div className="policy-summary-note">
              {getPolicyStatusMessage(tStatusMsg, analysis)}
            </div>
          )}
        </>
      )}

      {pf.fallbackReferences && (
        <PolicyFallbackReferences
          app={app}
          hasSummary={Boolean(analysis?.summary)}
        />
      )}
    </section>
  );
}

/**
 * Always-visible "Other privacy ratings" block. Keeps the user unstuck when
 * our own fetch lands on a cookie-wall, a geolocked redirect (e.g. Google
 * sending us to google.com root), or any other dead-end — they can still
 * click through to ToS;DR or PrivacySpy for a curated second opinion. When a
 * fresh summary *is* present we show the same links under a softer heading
 * so the user can cross-check what we produced.
 */

/**
 * Banner rendered just below the meta-pill row when the policy's current
 * version was first captured inside the configurable alert window and has
 * an earlier predecessor (i.e. an actual text change, not the first-ever
 * scrape). Clicking "View diff on History" switches tabs — the user then
 * expands the matching timeline row's "Show diff from previous version"
 * toggle to see the line+word diff. We deliberately don't embed the diff
 * here because the History tab is already the canonical place for it.
 */
