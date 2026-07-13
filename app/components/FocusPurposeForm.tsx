"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AGE_BAND_KEYS, type AgeBandKey } from "@/lib/age-rating";
import type { Audience } from "@/lib/feature-flag-rules";
import {
  type PrimaryPurpose,
  type PurposeFocusInput,
  type ResolvedPurposeFocus,
  resolvePurposeSelection,
} from "@/lib/onboarding-purpose";
import { useFlag } from "../../lib/feature-flags-hooks";
import {
  rovingTabIndex,
  useRovingRadioGroup,
} from "../../lib/use-roving-radiogroup";
import AccessibilityFigureGlyph from "./AccessibilityFigureGlyph";
import FeatureToggleRow from "./FeatureToggleRow";
import PurposeCardScene, { PURPOSE_ICONS } from "./PurposeCardScene";

interface FocusPurposeFormProps {
  cancelLabel?: string;
  error?: string;
  extraActions?: ReactNode;
  eyebrow?: string;
  footer?: ReactNode;
  initial: PurposeFocusInput;
  /** Stored guardian child age band, when one is set. */
  initialChildAgeBand?: AgeBandKey | null;
  intro?: ReactNode;
  mode: "onboarding" | "settings";
  onCancel?: () => void;
  onSubmit: (resolved: ResolvedPurposeFocus) => void | Promise<void>;
  saving?: boolean;
  savingLabel: string;
  submitLabel: string;
  subtitle: string;
  title: string;
}

const AUDIENCE_VALUES: readonly Audience[] = ["self", "loved_one", "guardian"];

const MONITOR_CHANGE_OPTIONS = [
  { appName: "ShoeDrop", labelKey: "location" },
  { appName: "ShoeDrop", labelKey: "purchases" },
  { appName: "ShoeDrop", labelKey: "contacts" },
  { appName: "ShoeDrop", labelKey: "health" },
  { appName: "ShoeDrop", labelKey: "identifiers" },
] as const;

type MonitorChangeOption = (typeof MONITOR_CHANGE_OPTIONS)[number];

export default function FocusPurposeForm({
  cancelLabel,
  error,
  extraActions,
  footer,
  initial,
  intro,
  initialChildAgeBand = null,
  mode,
  onCancel,
  onSubmit,
  saving = false,
  savingLabel,
  submitLabel,
  subtitle,
  title,
  eyebrow,
}: FocusPurposeFormProps) {
  const t = useTranslations("focus_purpose");
  const tAgeBand = useTranslations("age_band");
  const tAnimation = useTranslations("focus_purpose.animation");
  const tAudience = useTranslations("audience");
  const tGoal = useTranslations("goal");

  const audiencePickerOn = useFlag("flag.onboarding.audience_picker") === "on";
  const ageRatingFlag = useFlag("flag.guardian.age_rating");
  const goalsPickerOn = useFlag("flag.onboarding.goals_picker") === "on";
  const minimalOptionOn =
    useFlag("flag.onboarding.goals_picker.minimal_option") === "on";
  const accessibilityModifierOn =
    useFlag("flag.onboarding.goals_picker.accessibility_modifier") === "on";

  // Multi-select focus state — each goal tile maps to a boolean; the Help
  // tile is expressed through `audience`. "minimal" is the subtractive switch.
  const [monitor, setMonitor] = useState(initial.monitor);
  const [cleanup, setCleanup] = useState(initial.cleanup);
  const [minimal, setMinimal] = useState(initial.minimal);
  const [accessibility, setAccessibility] = useState(initial.accessibility);
  const [audience, setAudience] = useState<Audience>(initial.audience);
  const [childAgeBand, setChildAgeBand] = useState<AgeBandKey | null>(
    initialChildAgeBand
  );
  const [monitorChange, setMonitorChange] = useState<MonitorChangeOption>(
    MONITOR_CHANGE_OPTIONS[0]
  );

  // APG keyboard contract for the audience + child-age radiogroups: one tab
  // stop each, arrows move focus + selection.
  const radioKeyDown = useRovingRadioGroup();

  useEffect(() => {
    setMonitorChange(
      MONITOR_CHANGE_OPTIONS[
        Math.floor(Math.random() * MONITOR_CHANGE_OPTIONS.length)
      ]
    );
  }, []);

  const isHelp = audience !== "self";
  const monitorChangeText = tAnimation("monitor.change", {
    app: monitorChange.appName,
    label: tAnimation(`labels.${monitorChange.labelKey}`),
  });

  // Picking a goal tile clears "minimal" (they're mutually exclusive).
  function toggleMonitor() {
    setMonitor((prev) => {
      const next = !prev;
      if (next) {
        setMinimal(false);
      }
      return next;
    });
  }
  function toggleCleanup() {
    setCleanup((prev) => {
      const next = !prev;
      if (next) {
        setMinimal(false);
      }
      return next;
    });
  }
  // The Help tile and the "Someone else" audience are two views of the same
  // axis. Toggling Help flips between self and loved_one; "A child"
  // (guardian) is reachable only through the audience control below.
  function toggleHelp() {
    setAudience((prev) => (prev === "self" ? "loved_one" : "self"));
  }
  // Turning "Keep it minimal" on clears the additive goal tiles.
  function toggleMinimal() {
    setMinimal((prev) => {
      const next = !prev;
      if (next) {
        setMonitor(false);
        setCleanup(false);
      }
      return next;
    });
  }

  const tiles: { active: boolean; id: PrimaryPurpose; onClick: () => void }[] =
    [
      { id: "monitor", active: monitor, onClick: toggleMonitor },
      ...(goalsPickerOn
        ? [{ id: "cleanup" as const, active: cleanup, onClick: toggleCleanup }]
        : []),
      ...(audiencePickerOn
        ? [{ id: "help" as const, active: isHelp, onClick: toggleHelp }]
        : []),
    ];

  // Show the child-age section when the form's selected audience is guardian.
  // When the SAVED audience is already guardian the resolved flag is
  // authoritative (kill-switch / override); a mid-form switch to guardian
  // can't resolve the flag yet, so it always shows.
  const showChildAgeSection =
    audience === "guardian" &&
    !(initial.audience === "guardian" && ageRatingFlag !== "on");

  async function handleSubmit() {
    const resolved = resolvePurposeSelection({
      audience,
      monitor,
      cleanup,
      minimal,
      accessibility,
    });
    await onSubmit({ ...resolved, childAgeBand });
  }

  return (
    <div className="wizard-outer">
      <div
        className={`wizard-card wizard-card-wide focus-purpose-card focus-purpose-card--${mode}`}
      >
        {eyebrow && <div className="welcome-eyebrow">{eyebrow}</div>}
        <h1 className="wizard-title">{title}</h1>
        <p className="wizard-subtitle">{subtitle}</p>
        {intro}

        {tiles.length > 0 && (
          <div
            aria-label={t("primary_aria")}
            className="method-grid welcome-grid focus-purpose-grid"
            role="group"
          >
            {tiles.map((tile) => (
              <button
                aria-pressed={tile.active}
                className={`method-card welcome-card focus-purpose-option ${tile.active ? "active" : ""}`}
                disabled={saving}
                key={tile.id}
                onClick={tile.onClick}
                type="button"
              >
                <div className="method-card-top">
                  {mode === "onboarding" ? (
                    <PurposeCardScene
                      deleteLabel={tAnimation("cleanup.delete")}
                      helpDetail={tAnimation("help.detail")}
                      helpTitle={tAnimation("help.title")}
                      monitorChangeText={monitorChangeText}
                      monitorTitle={tAnimation("monitor.title")}
                      purpose={tile.id}
                    />
                  ) : (
                    <span aria-hidden="true" className="welcome-card-icon">
                      {PURPOSE_ICONS[tile.id]}
                    </span>
                  )}
                  <span aria-hidden="true" className="method-card-radio">
                    {tile.active ? "✓" : ""}
                  </span>
                </div>
                <div className="method-card-title">
                  {t(`primary.${tile.id}.title`)}
                </div>
                <p className="method-card-copy">
                  {t(`primary.${tile.id}.body`)}
                </p>
              </button>
            ))}
          </div>
        )}

        {audiencePickerOn && (
          <div className="focus-purpose-audience">
            <h2 className="focus-purpose-secondary-heading">
              {t("audience_heading")}
            </h2>
            <div
              aria-label={t("audience_heading")}
              className="focus-purpose-segmented focus-purpose-segmented--three"
              onKeyDown={radioKeyDown}
              role="radiogroup"
            >
              {AUDIENCE_VALUES.map((value) => (
                <button
                  aria-checked={audience === value}
                  className={`focus-purpose-segment ${audience === value ? "is-active" : ""}`}
                  disabled={saving}
                  key={value}
                  onClick={() => setAudience(value)}
                  role="radio"
                  tabIndex={audience === value ? 0 : -1}
                  type="button"
                >
                  <strong>{tAudience(`${value}.label`)}</strong>
                  <span>{tAudience(`${value}.subtext`)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {showChildAgeSection && (
          <div className="focus-purpose-branch-group focus-guardian-age">
            <h2 className="focus-purpose-branch-heading">
              {t("guardian_age.heading")}
            </h2>
            <p className="focus-guardian-age-hint">{t("guardian_age.hint")}</p>
            <div
              aria-label={t("guardian_age.heading")}
              className="focus-purpose-pills"
              onKeyDown={radioKeyDown}
              role="radiogroup"
            >
              {AGE_BAND_KEYS.map((band, index) => (
                <button
                  aria-checked={childAgeBand === band}
                  className={`pill-button ${childAgeBand === band ? "active" : ""}`}
                  disabled={saving}
                  key={band}
                  onClick={() =>
                    setChildAgeBand((prev) => (prev === band ? null : band))
                  }
                  role="radio"
                  tabIndex={rovingTabIndex(
                    childAgeBand === band,
                    index,
                    childAgeBand !== null
                  )}
                  type="button"
                >
                  {tAgeBand(`labels.${band}`)}
                </button>
              ))}
            </div>
            <p className="focus-guardian-age-resources">
              <Link className="welcome-link" href="/help/parental-controls">
                {t("guardian_age.resources_link")}
              </Link>
            </p>
          </div>
        )}

        {(minimalOptionOn || accessibilityModifierOn) && (
          <div className="focus-purpose-secondary">
            <h2 className="focus-purpose-secondary-heading">
              {t("secondary.heading")}
            </h2>
            <div className="focus-purpose-secondary-grid">
              {minimalOptionOn && (
                <button
                  aria-pressed={minimal}
                  className={`method-card welcome-card goal-card focus-purpose-secondary-option ${minimal ? "active" : ""}`}
                  disabled={saving}
                  onClick={toggleMinimal}
                  type="button"
                >
                  <div className="method-card-top">
                    <span aria-hidden="true" className="welcome-card-icon">
                      🍃
                    </span>
                    <span aria-hidden="true" className="method-card-radio">
                      {minimal ? "✓" : ""}
                    </span>
                  </div>
                  <div className="method-card-title">
                    {tGoal("minimal.label")}
                  </div>
                  <p className="method-card-copy">{tGoal("minimal.subtext")}</p>
                </button>
              )}
              {accessibilityModifierOn && (
                <button
                  aria-pressed={accessibility}
                  className={`method-card welcome-card goal-card goal-card-modifier focus-purpose-secondary-option ${accessibility ? "active" : ""}`}
                  disabled={saving}
                  onClick={() => setAccessibility((prev) => !prev)}
                  type="button"
                >
                  <div className="method-card-top">
                    <span aria-hidden="true" className="welcome-card-icon">
                      <AccessibilityFigureGlyph size={28} />
                    </span>
                    <span aria-hidden="true" className="method-card-radio">
                      {accessibility ? "✓" : ""}
                    </span>
                  </div>
                  <div className="method-card-title">
                    {t("secondary.accessibility.title")}
                  </div>
                  <p className="method-card-copy">
                    {t("secondary.accessibility.body")}
                  </p>
                </button>
              )}
            </div>
          </div>
        )}

        {mode === "settings" && <FeatureToggleRow />}

        {error && (
          <div aria-live="assertive" className="welcome-error" role="alert">
            {error}
          </div>
        )}

        <div className="welcome-actions focus-purpose-actions">
          {onCancel && cancelLabel && (
            <button
              className="btn btn-ghost"
              disabled={saving}
              onClick={onCancel}
              type="button"
            >
              {cancelLabel}
            </button>
          )}
          <button
            className="btn btn-primary"
            disabled={saving}
            onClick={() => void handleSubmit()}
            type="button"
          >
            {saving ? savingLabel : submitLabel}
          </button>
          {extraActions}
        </div>

        {footer}
      </div>
    </div>
  );
}
