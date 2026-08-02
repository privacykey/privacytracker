"use client";

/**
 * Developer Options → per-phase AI request timeouts, in a collapsed
 * accordion.
 *
 * Collapsed by default because the defaults work for hosted providers and
 * most local setups; it only becomes interesting once a user hits a
 * timeout. The bell notification deep-links here via `#ai-timeouts`, and
 * that id is a cross-page contract — see ./README.md.
 *
 * `flag.devopts.advanced_accordion` is three-valued, not a boolean: `off`
 * hides the accordion, `on` forces it open on first paint, and anything
 * else (the 'collapsed' default) surfaces it shut. That is why the flag
 * itself is read here rather than a resolved boolean.
 */

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { useFlag } from "@/lib/feature-flags-hooks";
import type { useSettingsAutoSave } from "@/lib/use-settings-auto-save";
import { pushSettingsToast } from "../SettingsAutoSaveToast";

type TimeoutAutoSave = ReturnType<typeof useSettingsAutoSave<string>>;

export default function AiTimeoutsPanel({
  aiProvider,
  advancedAiOpen,
  setAdvancedAiOpen,
  aiTimeoutDirectMs,
  setAiTimeoutDirectMs,
  aiTimeoutDirectAutoSave,
  aiTimeoutChunkMs,
  setAiTimeoutChunkMs,
  aiTimeoutChunkAutoSave,
  aiTimeoutMergeMs,
  setAiTimeoutMergeMs,
  aiTimeoutMergeAutoSave,
}: {
  /** Every field is inert while AI is disabled — there is nothing to time out. */
  aiProvider: string;
  advancedAiOpen: boolean;
  setAdvancedAiOpen: (next: boolean) => void;
  aiTimeoutDirectMs: string;
  setAiTimeoutDirectMs: (next: string) => void;
  aiTimeoutDirectAutoSave: TimeoutAutoSave;
  aiTimeoutChunkMs: string;
  setAiTimeoutChunkMs: (next: string) => void;
  aiTimeoutChunkAutoSave: TimeoutAutoSave;
  aiTimeoutMergeMs: string;
  setAiTimeoutMergeMs: (next: string) => void;
  aiTimeoutMergeAutoSave: TimeoutAutoSave;
}) {
  const devAdvancedAccordionFlag = useFlag("flag.devopts.advanced_accordion");
  const devAdvancedAccordionOn = devAdvancedAccordionFlag !== "off";
  const settingsAiTimeoutConfigOn =
    useFlag("flag.settings.ai.timeout_config") === "on";
  const tPh = useTranslations("settings.placeholders");
  const tDevAiTimeouts = useTranslations("settings.dev_options.ai_timeouts");

  /** Validator shared by all three AI timeout fields. Empty → ok (means
   * "use default"). Non-empty must be an int between 10s and 15min. */
  const validateAiTimeout = useCallback((raw: string): string | null => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      return null; // empty = default, allowed
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000 || parsed > 15 * 60_000) {
      return "Timeout must be 10000–900000 ms";
    }
    return null;
  }, []);

  const makeAiTimeoutBlurHandler =
    (raw: string, saver: (value: string) => Promise<unknown>) => () => {
      const err = validateAiTimeout(raw);
      if (err) {
        pushSettingsToast({ kind: "error", message: err });
        return;
      }
      void saver(raw.trim());
    };

  return (
    <>
      {/* Advanced — per-phase AI request timeouts. Collapsed by default
            because the defaults work for hosted providers and most local
            setups; only becomes interesting once a user hits a timeout
            (the bell notification routes them straight here via
            #ai-timeouts, and the accordion auto-opens on that hash).
            Wave I — gated behind `flag.devopts.advanced_accordion`; the
            'collapsed' default surfaces the accordion but keeps it shut
            on first paint so users without focus tweaks don't see it
            sprawling open. */}
      {devAdvancedAccordionOn && settingsAiTimeoutConfigOn && (
        <details
          className="settings-advanced-details"
          id="ai-timeouts"
          onToggle={(event) =>
            setAdvancedAiOpen((event.target as HTMLDetailsElement).open)
          }
          open={devAdvancedAccordionFlag === "on" || advancedAiOpen}
          style={{
            marginTop: 24,
            borderTop: "1px solid var(--border)",
            paddingTop: 16,
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
              userSelect: "none",
            }}
          >
            {tDevAiTimeouts("summary")}
          </summary>
          <p
            className="settings-field-help"
            style={{ marginTop: 12, marginBottom: 12 }}
          >
            {tDevAiTimeouts("help")}
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                {tDevAiTimeouts("direct_label")}
              </span>
              <input
                className="settings-input"
                disabled={
                  aiProvider === "disabled" || aiTimeoutDirectAutoSave.saving
                }
                max={15 * 60_000}
                min={10_000}
                // Auto-save on blur — empty allowed (= server default),
                // otherwise must be 10000–900000 ms (validateAiTimeout).
                onBlur={makeAiTimeoutBlurHandler(
                  aiTimeoutDirectMs,
                  aiTimeoutDirectAutoSave.save
                )}
                onChange={(event) => setAiTimeoutDirectMs(event.target.value)}
                placeholder={tPh("default")}
                step={1000}
                type="number"
                value={aiTimeoutDirectMs}
              />
              <span className="settings-field-help">
                {tDevAiTimeouts("direct_help")}
              </span>
            </label>

            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                {tDevAiTimeouts("chunk_label")}
              </span>
              <input
                className="settings-input"
                disabled={
                  aiProvider === "disabled" || aiTimeoutChunkAutoSave.saving
                }
                max={15 * 60_000}
                min={10_000}
                onBlur={makeAiTimeoutBlurHandler(
                  aiTimeoutChunkMs,
                  aiTimeoutChunkAutoSave.save
                )}
                onChange={(event) => setAiTimeoutChunkMs(event.target.value)}
                placeholder={tPh("default")}
                step={1000}
                type="number"
                value={aiTimeoutChunkMs}
              />
              <span className="settings-field-help">
                {tDevAiTimeouts("chunk_help")}
              </span>
            </label>

            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                {tDevAiTimeouts("merge_label")}
              </span>
              <input
                className="settings-input"
                disabled={
                  aiProvider === "disabled" || aiTimeoutMergeAutoSave.saving
                }
                max={15 * 60_000}
                min={10_000}
                onBlur={makeAiTimeoutBlurHandler(
                  aiTimeoutMergeMs,
                  aiTimeoutMergeAutoSave.save
                )}
                onChange={(event) => setAiTimeoutMergeMs(event.target.value)}
                placeholder={tPh("default")}
                step={1000}
                type="number"
                value={aiTimeoutMergeMs}
              />
              <span className="settings-field-help">
                {tDevAiTimeouts("merge_help")}
              </span>
            </label>
          </div>

          <p className="settings-field-help" style={{ marginTop: 12 }}>
            {tDevAiTimeouts.rich("footer", {
              save: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
        </details>
      )}
    </>
  );
}
