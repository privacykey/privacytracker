"use client";

/**
 * Developer Options → AI debug log. Opt-in capture of the full
 * prompt/response payload for each AI call, plus the rolling window the
 * server keeps.
 *
 * Two flags gate it and both must be on: `flag.devopts.ai.debug_logging`
 * (does this install expose dev options at all) and
 * `flag.settings.ai.debug_logging` (does this Settings card show it).
 * They're resolved here rather than passed down because they decide what
 * is *inside* this panel — SettingsView still owns the section-level gate.
 *
 * The toggle itself is not local state: `debugLogging` round-trips through
 * the AI settings blob, so it stays in SettingsView with the rest of that
 * form and arrives here as a prop.
 */

import { useTranslations } from "next-intl";
import { useFlag } from "@/lib/feature-flags-hooks";
import { fmtDate } from "./format";
import type { AiDebugLogRow } from "./types";

export default function AiDebugLogPanel({
  debugLogging,
  setDebugLogging,
  saveAiSettings,
  debugLog,
  debugLoading,
  loadDebugLog,
  clearDebugLog,
  debugExpandedId,
  setDebugExpandedId,
}: {
  debugLogging: boolean;
  setDebugLogging: (next: boolean) => void;
  /** Persists the AI settings blob; only `debugLogging` is overridden here. */
  saveAiSettings: (overrides: { debugLogging: boolean }) => void;
  /** null until the user first loads the log — the fetch is deliberately lazy. */
  debugLog: AiDebugLogRow[] | null;
  debugLoading: boolean;
  loadDebugLog: () => Promise<void>;
  clearDebugLog: () => Promise<void>;
  debugExpandedId: string | null;
  setDebugExpandedId: (next: (prev: string | null) => string | null) => void;
}) {
  const devAiDebugLoggingOn = useFlag("flag.devopts.ai.debug_logging") === "on";
  const settingsAiDebugLoggingOn =
    useFlag("flag.settings.ai.debug_logging") === "on";
  const tSettings = useTranslations("settings");
  const tDevAiDebug = useTranslations("settings.dev_options.ai_debug");

  return (
    <>
      {/* Wave I: the whole AI debug-logging surface — toggle, load/clear
            buttons, and the rolling log list — is gated behind two flags:
            `flag.devopts.ai.debug_logging` (the dev-opts visibility) and
            `flag.settings.ai.debug_logging` (the per-Settings card flag).
            Both have to resolve on for the block to show; either off
            collapses it. */}
      {devAiDebugLoggingOn && settingsAiDebugLoggingOn && (
        <>
          <label className="settings-checkbox-row">
            <input
              checked={debugLogging}
              className="settings-checkbox"
              onChange={(event) => {
                const next = event.target.checked;
                setDebugLogging(next);
                saveAiSettings({ debugLogging: next });
              }}
              type="checkbox"
            />
            <span>
              {tDevAiDebug("label")}
              <span
                className="settings-field-help"
                style={{ display: "block", marginTop: 4 }}
              >
                {tDevAiDebug("help")}
              </span>
            </span>
          </label>

          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              marginTop: 16,
            }}
          >
            <button
              className="btn btn-secondary"
              disabled={debugLoading}
              onClick={() => void loadDebugLog()}
              type="button"
            >
              {debugLoading ? (
                <>
                  <span className="spinner-sm" /> {tDevAiDebug("loading")}
                </>
              ) : debugLog === null ? (
                tDevAiDebug("load")
              ) : (
                tDevAiDebug("refresh")
              )}
            </button>
            {debugLog !== null && debugLog.length > 0 && (
              <button
                className="btn btn-secondary"
                disabled={debugLoading}
                onClick={() => void clearDebugLog()}
                type="button"
              >
                {tDevAiDebug("clear")}
              </button>
            )}
          </div>

          {debugLog !== null && (
            <div style={{ marginTop: 16 }}>
              {debugLog.length === 0 ? (
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--text-3)",
                    padding: "12px 2px",
                  }}
                >
                  {debugLogging
                    ? tDevAiDebug("empty_active")
                    : tDevAiDebug("empty_off")}
                </div>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {debugLog.map((row) => {
                    const isExpanded = debugExpandedId === row.id;
                    const label = row.appName
                      ? `${row.appName} · ${row.phase ?? tDevAiDebug("unknown_phase")}`
                      : (row.phase ?? tDevAiDebug("fallback_label"));
                    const providerLabel = row.provider
                      ? `${row.provider}${row.model ? ` / ${row.model}` : ""}`
                      : "";
                    return (
                      <li
                        key={row.id}
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          padding: 12,
                          background: row.error
                            ? "rgba(255, 80, 80, 0.04)"
                            : "var(--surface-2)",
                        }}
                      >
                        <button
                          aria-expanded={isExpanded}
                          onClick={() =>
                            setDebugExpandedId((prev) =>
                              prev === row.id ? null : row.id
                            )
                          }
                          style={{
                            all: "unset",
                            cursor: "pointer",
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                            width: "100%",
                          }}
                          type="button"
                        >
                          <div
                            style={{
                              display: "flex",
                              gap: 10,
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                fontWeight: 600,
                                fontSize: 13,
                              }}
                            >
                              {row.error ? "⚠ " : "✓ "}
                              {label}
                            </span>
                            {providerLabel && (
                              <span
                                style={{
                                  fontSize: 12,
                                  color: "var(--text-3)",
                                }}
                              >
                                · {providerLabel}
                              </span>
                            )}
                            <span
                              style={{
                                marginLeft: "auto",
                                fontSize: 12,
                                color: "var(--text-3)",
                              }}
                            >
                              {fmtDate(tSettings, row.createdAt)}
                              {typeof row.durationMs === "number" &&
                                tDevAiDebug("duration_suffix", {
                                  ms: row.durationMs,
                                })}
                            </span>
                          </div>
                          {row.error && !isExpanded && (
                            <div
                              style={{
                                fontSize: 12,
                                color: "var(--red, #c03)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {row.error}
                            </div>
                          )}
                        </button>

                        {isExpanded && (
                          <div
                            style={{
                              marginTop: 12,
                              display: "flex",
                              flexDirection: "column",
                              gap: 10,
                            }}
                          >
                            {row.error && (
                              <div
                                style={{
                                  fontSize: 12,
                                  color: "var(--red, #c03)",
                                  background: "rgba(255, 80, 80, 0.08)",
                                  padding: "8px 10px",
                                  borderRadius: 6,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                }}
                              >
                                {row.error}
                              </div>
                            )}
                            <div>
                              <div
                                style={{
                                  fontSize: 12,
                                  color: "var(--text-3)",
                                  marginBottom: 4,
                                }}
                              >
                                {tDevAiDebug("prompt_heading")}
                              </div>
                              <pre
                                style={{
                                  margin: 0,
                                  padding: 10,
                                  background: "var(--surface-1)",
                                  border: "1px solid var(--border)",
                                  borderRadius: 6,
                                  fontSize: 12,
                                  lineHeight: 1.45,
                                  maxHeight: 320,
                                  overflow: "auto",
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                }}
                              >
                                {row.prompt || tDevAiDebug("empty_value")}
                              </pre>
                            </div>
                            <div>
                              <div
                                style={{
                                  fontSize: 12,
                                  color: "var(--text-3)",
                                  marginBottom: 4,
                                }}
                              >
                                {tDevAiDebug("response_heading")}
                              </div>
                              <pre
                                style={{
                                  margin: 0,
                                  padding: 10,
                                  background: "var(--surface-1)",
                                  border: "1px solid var(--border)",
                                  borderRadius: 6,
                                  fontSize: 12,
                                  lineHeight: 1.45,
                                  maxHeight: 320,
                                  overflow: "auto",
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                }}
                              >
                                {row.response || tDevAiDebug("empty_value")}
                              </pre>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
