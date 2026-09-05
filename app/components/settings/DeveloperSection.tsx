"use client";

/**
 * Developer Options — the debugging surface: AI call logging, the
 * operational activity log, per-phase AI timeouts, and the feature-flag
 * panel.
 *
 * This is a composition shell. Each of the three panels below owns its own
 * markup and its own sub-flags, because each was independently gated and
 * independently stateful; a single 900-line component taking fifty props
 * was the alternative. SettingsView still owns the section-level
 * `flag.devopts.visible` gate — see ./README.md.
 *
 * Anchor id `developer` matches the SettingsSidebar entry.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useFlag } from "@/lib/feature-flags-hooks";
import type { useSettingsAutoSave } from "@/lib/use-settings-auto-save";
import DevOptionsFeatureFlagPanel from "../DevOptionsFeatureFlagPanel";
import TasksResetRow from "../TasksResetRow";
import ActivityLogPanel from "./ActivityLogPanel";
import AiDebugLogPanel from "./AiDebugLogPanel";
import AiTimeoutsPanel from "./AiTimeoutsPanel";

type TimeoutAutoSave = ReturnType<typeof useSettingsAutoSave<string>>;

export default function DeveloperSection({
  showToast,
  debugLogging,
  setDebugLogging,
  saveAiSettings,
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
  showToast: (msg: string) => void;
  debugLogging: boolean;
  setDebugLogging: (next: boolean) => void;
  saveAiSettings: (overrides: { debugLogging: boolean }) => void;
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
  const tSections = useTranslations("settings.sections");
  const tSub = useTranslations("settings.subtitles");
  const tDevPresets = useTranslations("settings.dev_options.presets");
  const devFeatureFlagPresetsOn =
    useFlag("flag.devopts.feature_flag_presets") === "on";

  return (
    <div className="settings-section" id="developer">
      <h2 className="settings-section-title">
        {tSections("developer_options")}
      </h2>
      <p className="settings-section-subtitle">{tSub("developer_options")}</p>

      <TasksResetRow />
      <AiDebugLogPanel
        debugLogging={debugLogging}
        saveAiSettings={saveAiSettings}
        setDebugLogging={setDebugLogging}
        showToast={showToast}
      />

      <ActivityLogPanel showToast={showToast} />

      <AiTimeoutsPanel
        advancedAiOpen={advancedAiOpen}
        aiProvider={aiProvider}
        aiTimeoutChunkAutoSave={aiTimeoutChunkAutoSave}
        aiTimeoutChunkMs={aiTimeoutChunkMs}
        aiTimeoutDirectAutoSave={aiTimeoutDirectAutoSave}
        aiTimeoutDirectMs={aiTimeoutDirectMs}
        aiTimeoutMergeAutoSave={aiTimeoutMergeAutoSave}
        aiTimeoutMergeMs={aiTimeoutMergeMs}
        setAdvancedAiOpen={setAdvancedAiOpen}
        setAiTimeoutChunkMs={setAiTimeoutChunkMs}
        setAiTimeoutDirectMs={setAiTimeoutDirectMs}
        setAiTimeoutMergeMs={setAiTimeoutMergeMs}
      />

      {/* Round 3 PR 5: feature-flag panel inside the existing Developer
            Options section. Pulls flag list + override state from
            /api/feature-flags on mount; toggle/reset hit the override
            endpoints. Sits below the AI debug log so users who only need
            debug logging aren't scrolled past it. */}
      <div
        style={{
          marginTop: 32,
          paddingTop: 24,
          borderTop: "1px solid var(--border)",
        }}
      >
        {devFeatureFlagPresetsOn && (
          <div
            className="settings-field"
            style={{
              marginBottom: 12,
              padding: "8px 12px",
              background: "rgba(59, 130, 246, 0.06)",
              border: "1px dashed rgba(59, 130, 246, 0.35)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--text-2)",
            }}
          >
            <strong>{tDevPresets("lead")}</strong>
            {tDevPresets("body")}
          </div>
        )}
        {/* Authoring tool: write-down-the-spec matrix for which
              flags should resolve to what under each (audience × goals)
              combo. Sits above the live-overrides panel because it's
              a planning surface — authors typically iterate the spec
              first, then promote a column into live overrides via the
              matrix's "Apply combo" buttons or paste the generated TS
              patch into lib/feature-flag-rules.ts. */}
        <div
          className="settings-field"
          style={{
            marginBottom: 16,
            padding: "10px 12px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: "1 1 240px", minWidth: 240 }}>
            <strong style={{ fontSize: 13 }}>Focus × Flags matrix</strong>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-3)",
                marginTop: 2,
              }}
            >
              Author the desired flag value for every (audience × goals) combo.
              Saves a draft locally; export as JSON or a TS patch when
              you&rsquo;re ready.
            </div>
          </div>
          <Link
            className="btn btn-secondary"
            href="/dashboard/settings/focus-matrix"
            style={{ fontSize: 13 }}
          >
            Open matrix →
          </Link>
        </div>
        <DevOptionsFeatureFlagPanel />
      </div>
    </div>
  );
}
