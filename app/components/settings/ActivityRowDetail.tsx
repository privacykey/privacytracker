"use client";

/**
 * Renders the expanded detail panel for one activity-log row.
 *
 * For rows with `status === 'error'` and a `detail.fetchDiagnostics` block
 * (populated by lib/privacy-policy.ts → PolicyFetchError, or lib/scraper.ts'
 * HTTP-aware catch block), we render a structured troubleshoot panel —
 * HTTP status, requested/final URL, origin, content-type, and any
 * remediation hints. Every other row falls back to the pre-existing
 * raw JSON dump so we don't regress the debug visibility the dev log
 * always had.
 */

import { useTranslations } from "next-intl";
import type { ActivityLogRow } from "@/lib/use-activity-log";

export default function ActivityRowDetail({ row }: { row: ActivityLogRow }) {
  const tTroubleshoot = useTranslations(
    "settings.dev_options.activity_log.troubleshoot"
  );
  const detail = row.detail;
  if (!detail) {
    return null;
  }

  const fetchDiag = (detail as Record<string, unknown>).fetchDiagnostics as
    | Record<string, unknown>
    | undefined;
  const errorMessage =
    typeof (detail as Record<string, unknown>).errorMessage === "string"
      ? ((detail as Record<string, unknown>).errorMessage as string)
      : null;

  // Scalar info rows rendered as a small definition list. Kept as a plain
  // array so we can filter out absent fields in one pass rather than
  // wrapping each in its own conditional JSX block.
  const diagnosticLines: Array<{ label: string; value: string }> = [];
  if (fetchDiag) {
    if (typeof fetchDiag.httpStatus === "number") {
      diagnosticLines.push({
        label: tTroubleshoot("label_http_status"),
        value: String(fetchDiag.httpStatus),
      });
    }
    if (typeof fetchDiag.origin === "string") {
      // Map raw origin identifiers to locale keys; unknown values fall
      // back to the raw string rather than rendering a missing-key error.
      const ORIGIN_LABEL_KEYS: Record<string, string> = {
        direct: "origin_direct",
        browser_retry: "origin_browser_retry",
        wayback: "origin_wayback",
        normalize: "origin_normalize",
      };
      const originKey = ORIGIN_LABEL_KEYS[fetchDiag.origin as string];
      diagnosticLines.push({
        label: tTroubleshoot("label_failed_attempt"),
        value: originKey ? tTroubleshoot(originKey) : String(fetchDiag.origin),
      });
    }
    if (typeof fetchDiag.contentType === "string" && fetchDiag.contentType) {
      diagnosticLines.push({
        label: tTroubleshoot("label_content_type"),
        value: fetchDiag.contentType as string,
      });
    }
    if (typeof fetchDiag.networkHint === "string" && fetchDiag.networkHint) {
      const NETWORK_HINT_LABEL_KEYS: Record<string, string> = {
        timeout: "network_timeout",
        dns: "network_dns",
        connection_reset: "network_connection_reset",
        network: "network_generic",
      };
      const hintKey = NETWORK_HINT_LABEL_KEYS[fetchDiag.networkHint as string];
      diagnosticLines.push({
        label: tTroubleshoot("label_network"),
        value: hintKey ? tTroubleshoot(hintKey) : String(fetchDiag.networkHint),
      });
    }
  }

  const requestedUrl =
    fetchDiag && typeof fetchDiag.requestedUrl === "string"
      ? (fetchDiag.requestedUrl as string)
      : typeof (detail as Record<string, unknown>).url === "string"
        ? ((detail as Record<string, unknown>).url as string)
        : null;
  const finalUrl =
    fetchDiag && typeof fetchDiag.finalUrl === "string"
      ? (fetchDiag.finalUrl as string)
      : null;
  const troubleshoot =
    fetchDiag && Array.isArray(fetchDiag.troubleshoot)
      ? ((fetchDiag.troubleshoot as unknown[]).filter(
          (x) => typeof x === "string"
        ) as string[])
      : [];

  const showTroubleshoot =
    row.status === "error" &&
    (fetchDiag || errorMessage) &&
    (diagnosticLines.length > 0 ||
      troubleshoot.length > 0 ||
      requestedUrl ||
      errorMessage);

  return (
    <div className="activity-log-detail-wrap">
      {showTroubleshoot && (
        <div className="activity-log-troubleshoot">
          <div className="activity-log-troubleshoot-title">
            {tTroubleshoot("title")}
          </div>
          {errorMessage && (
            <div className="activity-log-troubleshoot-message">
              {errorMessage}
            </div>
          )}
          {diagnosticLines.length > 0 && (
            <dl className="activity-log-troubleshoot-facts">
              {diagnosticLines.map((line) => (
                <div
                  className="activity-log-troubleshoot-fact"
                  key={line.label}
                >
                  <dt>{line.label}</dt>
                  <dd>{line.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {(requestedUrl || finalUrl) && (
            <dl className="activity-log-troubleshoot-facts">
              {requestedUrl && (
                <div className="activity-log-troubleshoot-fact">
                  <dt>{tTroubleshoot("label_requested_url")}</dt>
                  <dd>
                    <a
                      href={requestedUrl}
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      {requestedUrl}
                    </a>
                  </dd>
                </div>
              )}
              {finalUrl && finalUrl !== requestedUrl && (
                <div className="activity-log-troubleshoot-fact">
                  <dt>{tTroubleshoot("label_final_url")}</dt>
                  <dd>
                    <a
                      href={finalUrl}
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      {finalUrl}
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          )}
          {troubleshoot.length > 0 && (
            <>
              <div className="activity-log-troubleshoot-subtitle">
                {tTroubleshoot("try_title")}
              </div>
              <ul className="activity-log-troubleshoot-hints">
                {troubleshoot.map((hint, index) => (
                  <li key={index}>{hint}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <details className="activity-log-detail-raw">
        <summary>{tTroubleshoot("raw_json")}</summary>
        <pre className="activity-log-detail">
          {JSON.stringify(detail, null, 2)}
        </pre>
      </details>
    </div>
  );
}

// AuditBundleExport extracted to ./AuditBundleExport.tsx — the inline
// helper that used to live here is now imported at the top of the file.
