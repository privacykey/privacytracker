"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { Audience } from "@/lib/feature-flag-rules";
import type { FocusWorkflow } from "@/lib/focus-workflow";
import {
  type PrimaryPurpose,
  type PurposeFocusInput,
  type ResolvedPurposeFocus,
  resolvePurposeSelection,
  selectionFromFocus,
} from "@/lib/onboarding-purpose";
import { useFlag } from "../../lib/feature-flags-hooks";
import AccessibilityFigureGlyph from "./AccessibilityFigureGlyph";

interface FocusPurposeFormProps {
  advancedInitiallyOpen?: boolean;
  cancelLabel?: string;
  error?: string;
  extraActions?: ReactNode;
  eyebrow?: string;
  footer?: ReactNode;
  initial: PurposeFocusInput;
  mode: "onboarding" | "settings";
  onCancel?: () => void;
  onSubmit: (resolved: ResolvedPurposeFocus) => void | Promise<void>;
  saving?: boolean;
  savingLabel: string;
  submitLabel: string;
  subtitle: string;
  title: string;
}

const AUDIENCE_LABEL_KEYS: Record<Audience, string> = {
  self: "self",
  loved_one: "loved_one",
  guardian: "guardian",
};

const PURPOSE_ICONS: Record<PrimaryPurpose, string> = {
  monitor: "↻",
  cleanup: "✓",
  help: "→",
  custom: "⋯",
};

const MONITOR_CHANGE_OPTIONS = [
  { appName: "ShoeDrop", labelKey: "location" },
  { appName: "ShoeDrop", labelKey: "purchases" },
  { appName: "ShoeDrop", labelKey: "contacts" },
  { appName: "ShoeDrop", labelKey: "health" },
  { appName: "ShoeDrop", labelKey: "identifiers" },
] as const;

type MonitorChangeOption = (typeof MONITOR_CHANGE_OPTIONS)[number];

const CLEANUP_REVIEW_APPS = [
  { action: "keep", name: "ShopPop" },
  { action: "remove", name: "OldChat" },
  { action: "keep", name: "Notes" },
  { action: "keep", name: "GameBox" },
] as const;

const CLEANUP_ACTION_MARKS = {
  keep: "✓",
  remove: "×",
} as const;

const HOME_SCREEN_APPS = [
  { action: "keep", name: "Mail", short: "M" },
  { action: "keep", name: "Maps", short: "M" },
  { action: "keep", name: "Notes", short: "N" },
  { action: "keep", name: "Pay", short: "P" },
  { action: "keep", name: "ShopPop", short: "S" },
  { action: "remove", name: "OldChat", short: "O" },
  { action: "keep", name: "GameBox", short: "G" },
  { action: "keep", name: "FitLoop", short: "F" },
] as const;

const FAMILY_PHONE_COLORS = ["blue", "green", "rose"] as const;

export default function FocusPurposeForm({
  advancedInitiallyOpen = false,
  cancelLabel,
  error,
  extraActions,
  footer,
  initial,
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
  const tAnimation = useTranslations("focus_purpose.animation");
  const tAudience = useTranslations("audience");
  const tGoal = useTranslations("goal");

  const audiencePickerOn = useFlag("flag.onboarding.audience_picker") === "on";
  const goalsPickerOn = useFlag("flag.onboarding.goals_picker") === "on";
  const minimalOptionOn =
    useFlag("flag.onboarding.goals_picker.minimal_option") === "on";
  const accessibilityModifierOn =
    useFlag("flag.onboarding.goals_picker.accessibility_modifier") === "on";

  const initialSelection = useMemo(
    () => selectionFromFocus(initial),
    [initial]
  );
  const [primary, setPrimary] = useState<PrimaryPurpose>(
    initialSelection.primary
  );
  const [helpRelationship, setHelpRelationship] = useState(
    initialSelection.helpRelationship ?? "adult"
  );
  const [helpOutcome, setHelpOutcome] = useState(
    initialSelection.helpOutcome ?? "handoff"
  );
  const [secondaryAccessibility, setSecondaryAccessibility] = useState(
    Boolean(initialSelection.secondary?.accessibility)
  );
  const [secondaryPolicy, setSecondaryPolicy] = useState(
    Boolean(initialSelection.secondary?.policy)
  );
  const [customFocus, setCustomFocus] = useState({
    audience: initial.audience,
    understand: initial.understand,
    declutter: initial.declutter,
    minimal: initial.minimal,
    accessibility: initial.accessibility,
    workflow: initial.workflow,
  });
  const [monitorChange, setMonitorChange] = useState<MonitorChangeOption>(
    MONITOR_CHANGE_OPTIONS[0]
  );

  useEffect(() => {
    setMonitorChange(
      MONITOR_CHANGE_OPTIONS[
        Math.floor(Math.random() * MONITOR_CHANGE_OPTIONS.length)
      ]
    );
  }, []);

  const purposeCards: PrimaryPurpose[] = [
    "monitor",
    ...(goalsPickerOn ? (["cleanup"] as const) : []),
    ...(audiencePickerOn ? (["help"] as const) : []),
  ];
  const monitorChangeText = tAnimation("monitor.change", {
    app: monitorChange.appName,
    label: tAnimation(`labels.${monitorChange.labelKey}`),
  });

  function updateCustom(
    patch: Partial<{
      accessibility: boolean;
      audience: Audience;
      declutter: boolean;
      minimal: boolean;
      understand: boolean;
      workflow: FocusWorkflow;
    }>
  ) {
    setPrimary("custom");
    setCustomFocus((prev) => {
      const next = { ...prev, ...patch, workflow: patch.workflow ?? "custom" };
      if (patch.minimal === true) {
        next.understand = false;
        next.declutter = false;
      }
      if ((patch.understand || patch.declutter) && next.minimal) {
        next.minimal = false;
      }
      return next;
    });
  }

  async function handleSubmit() {
    const resolved = resolvePurposeSelection({
      primary,
      helpRelationship,
      helpOutcome,
      secondary: {
        accessibility: secondaryAccessibility,
        policy: secondaryPolicy,
      },
      advanced: customFocus,
    });
    await onSubmit(resolved);
  }

  return (
    <div className="wizard-outer">
      <div
        className={`wizard-card wizard-card-wide focus-purpose-card focus-purpose-card--${mode}`}
      >
        {eyebrow && <div className="welcome-eyebrow">{eyebrow}</div>}
        <h1 className="wizard-title">{title}</h1>
        <p className="wizard-subtitle">{subtitle}</p>

        {purposeCards.length > 0 && (
          <div
            aria-label={t("primary_aria")}
            className="method-grid welcome-grid focus-purpose-grid"
            role="group"
          >
            {purposeCards.map((purpose) => {
              const active = primary === purpose;
              return (
                <button
                  aria-pressed={active}
                  className={`method-card welcome-card focus-purpose-option ${active ? "active" : ""}`}
                  disabled={saving}
                  key={purpose}
                  onClick={() => setPrimary(purpose)}
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
                        purpose={purpose}
                      />
                    ) : (
                      <span aria-hidden="true" className="welcome-card-icon">
                        {PURPOSE_ICONS[purpose]}
                      </span>
                    )}
                    <span aria-hidden="true" className="method-card-radio">
                      {active ? "✓" : ""}
                    </span>
                  </div>
                  <div className="method-card-title">
                    {t(`primary.${purpose}.title`)}
                  </div>
                  <p className="method-card-copy">
                    {t(`primary.${purpose}.body`)}
                  </p>
                </button>
              );
            })}
          </div>
        )}

        {primary === "help" && audiencePickerOn && (
          <div className="focus-purpose-branch">
            <div className="focus-purpose-branch-group">
              <h2 className="focus-purpose-branch-heading">
                {t("help.relationship_heading")}
              </h2>
              <div className="focus-purpose-segmented" role="radiogroup">
                {(["adult", "child"] as const).map((value) => (
                  <button
                    aria-checked={helpRelationship === value}
                    className={`focus-purpose-segment ${helpRelationship === value ? "is-active" : ""}`}
                    disabled={saving}
                    key={value}
                    onClick={() => setHelpRelationship(value)}
                    role="radio"
                    type="button"
                  >
                    <strong>{t(`help.relationship.${value}.title`)}</strong>
                    <span>{t(`help.relationship.${value}.body`)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="focus-purpose-branch-group">
              <h2 className="focus-purpose-branch-heading">
                {t("help.outcome_heading")}
              </h2>
              <div className="focus-purpose-segmented" role="radiogroup">
                {(["handoff", "monitor"] as const).map((value) => (
                  <button
                    aria-checked={helpOutcome === value}
                    className={`focus-purpose-segment ${helpOutcome === value ? "is-active" : ""}`}
                    disabled={saving}
                    key={value}
                    onClick={() => setHelpOutcome(value)}
                    role="radio"
                    type="button"
                  >
                    <strong>{t(`help.outcome.${value}.title`)}</strong>
                    <span>{t(`help.outcome.${value}.body`)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="focus-purpose-secondary">
          <h2 className="focus-purpose-secondary-heading">
            {t("secondary.heading")}
          </h2>
          <div className="focus-purpose-secondary-grid">
            {accessibilityModifierOn && (
              <button
                aria-pressed={secondaryAccessibility}
                className={`method-card welcome-card goal-card goal-card-modifier focus-purpose-secondary-option ${secondaryAccessibility ? "active" : ""}`}
                disabled={saving}
                onClick={() => setSecondaryAccessibility((prev) => !prev)}
                type="button"
              >
                <div className="method-card-top">
                  <span aria-hidden="true" className="welcome-card-icon">
                    <AccessibilityFigureGlyph size={28} />
                  </span>
                  <span aria-hidden="true" className="method-card-radio">
                    {secondaryAccessibility ? "✓" : ""}
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
            {goalsPickerOn && (
              <button
                aria-pressed={secondaryPolicy}
                className={`method-card welcome-card goal-card focus-purpose-secondary-option ${secondaryPolicy ? "active" : ""}`}
                disabled={
                  saving || (primary === "custom" && customFocus.minimal)
                }
                onClick={() => setSecondaryPolicy((prev) => !prev)}
                type="button"
              >
                <div className="method-card-top">
                  <span aria-hidden="true" className="welcome-card-icon">
                    ¶
                  </span>
                  <span aria-hidden="true" className="method-card-radio">
                    {secondaryPolicy ? "✓" : ""}
                  </span>
                </div>
                <div className="method-card-title">
                  {t("secondary.policy.title")}
                </div>
                <p className="method-card-copy">{t("secondary.policy.body")}</p>
              </button>
            )}
          </div>
        </div>

        <details
          className="focus-advanced-panel"
          open={
            advancedInitiallyOpen || mode === "settings" || primary === "custom"
          }
        >
          <summary>{t("advanced.summary")}</summary>
          <div className="focus-advanced-grid">
            {audiencePickerOn && (
              <div className="focus-advanced-group">
                <h3>{t("advanced.audience")}</h3>
                <div className="focus-purpose-pills" role="radiogroup">
                  {(["self", "loved_one", "guardian"] as const).map((value) => (
                    <button
                      aria-checked={customFocus.audience === value}
                      className={`pill-button ${customFocus.audience === value && primary === "custom" ? "active" : ""}`}
                      disabled={saving}
                      key={value}
                      onClick={() => updateCustom({ audience: value })}
                      role="radio"
                      type="button"
                    >
                      {tAudience(`${AUDIENCE_LABEL_KEYS[value]}.label`)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {goalsPickerOn && (
              <div className="focus-advanced-group">
                <h3>{t("advanced.goals")}</h3>
                <div className="focus-purpose-pills">
                  <button
                    aria-pressed={
                      customFocus.understand && primary === "custom"
                    }
                    className={`pill-button ${customFocus.understand && primary === "custom" ? "active" : ""}`}
                    disabled={saving || customFocus.minimal}
                    onClick={() =>
                      updateCustom({ understand: !customFocus.understand })
                    }
                    type="button"
                  >
                    {tGoal("understand.label")}
                  </button>
                  <button
                    aria-pressed={customFocus.declutter && primary === "custom"}
                    className={`pill-button ${customFocus.declutter && primary === "custom" ? "active" : ""}`}
                    disabled={saving || customFocus.minimal}
                    onClick={() =>
                      updateCustom({ declutter: !customFocus.declutter })
                    }
                    type="button"
                  >
                    {tGoal("declutter.label")}
                  </button>
                  {minimalOptionOn && (
                    <button
                      aria-pressed={customFocus.minimal && primary === "custom"}
                      className={`pill-button ${customFocus.minimal && primary === "custom" ? "active" : ""}`}
                      disabled={saving}
                      onClick={() =>
                        updateCustom({ minimal: !customFocus.minimal })
                      }
                      type="button"
                    >
                      {tGoal("minimal.label")}
                    </button>
                  )}
                  {accessibilityModifierOn && (
                    <button
                      aria-pressed={
                        customFocus.accessibility && primary === "custom"
                      }
                      className={`pill-button ${customFocus.accessibility && primary === "custom" ? "active" : ""}`}
                      disabled={saving}
                      onClick={() =>
                        updateCustom({
                          accessibility: !customFocus.accessibility,
                        })
                      }
                      type="button"
                    >
                      {tGoal("accessibility.label")}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </details>

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

function PurposeCardScene({
  deleteLabel,
  helpDetail,
  helpTitle,
  monitorChangeText,
  monitorTitle,
  purpose,
}: {
  deleteLabel: string;
  helpDetail: string;
  helpTitle: string;
  monitorChangeText: string;
  monitorTitle: string;
  purpose: PrimaryPurpose;
}) {
  if (purpose === "monitor") {
    return (
      <div
        aria-hidden="true"
        className="focus-purpose-scene focus-purpose-scene--monitor"
      >
        <div className="fps-phone fps-monitor-phone">
          <div className="fps-phone-speaker" />
          <div className="fps-ios-app fps-ios-app--updating">
            <span className="fps-shared-app-mark" />
            <span className="fps-loader" />
          </div>
        </div>
        <div className="fps-desktop fps-monitor-desktop">
          <div className="fps-desktop-screen">
            <div className="fps-notification fps-monitor-notification">
              <span className="fps-notification-app-icon">
                <span className="fps-shared-app-mark" />
              </span>
              <strong>{monitorTitle}</strong>
              <span>{monitorChangeText}</span>
            </div>
          </div>
          <div className="fps-desktop-stand" />
        </div>
      </div>
    );
  }

  if (purpose === "cleanup") {
    return (
      <div
        aria-hidden="true"
        className="focus-purpose-scene focus-purpose-scene--cleanup"
      >
        <div className="fps-cleanup-list">
          {CLEANUP_REVIEW_APPS.map((app) => (
            <div className="fps-cleanup-row" key={app.name}>
              <span className="fps-cleanup-row-app">{app.name}</span>
              <span
                className={`fps-cleanup-row-action fps-cleanup-row-action--${app.action}`}
              >
                {CLEANUP_ACTION_MARKS[app.action]}
              </span>
            </div>
          ))}
        </div>
        <div className="fps-home-screen">
          <div className="fps-home-grid">
            {HOME_SCREEN_APPS.map((app, index) => (
              <span
                className={`fps-home-app fps-home-app--${index + 1} fps-home-app--${app.action}`}
                key={app.name}
              >
                <span className="fps-home-app-initial">{app.short}</span>
                {app.action === "remove" && (
                  <span className="fps-home-app-name">{app.name}</span>
                )}
              </span>
            ))}
          </div>
          <div className="fps-delete-confirm">{deleteLabel}</div>
          <span className="fps-tap-pulse" />
        </div>
      </div>
    );
  }

  if (purpose === "help") {
    return (
      <div
        aria-hidden="true"
        className="focus-purpose-scene focus-purpose-scene--help"
      >
        <div className="fps-family-phones">
          {FAMILY_PHONE_COLORS.map((color, phoneIndex) => (
            <div
              className={`fps-child-phone fps-child-phone--${color}`}
              key={color}
            >
              {Array.from({ length: 6 }).map((_, appIndex) => (
                <span
                  className={`fps-child-app fps-child-app--${phoneIndex + 1}-${appIndex + 1} ${
                    (color === "blue" || color === "green") && appIndex === 0
                      ? "fps-child-app--flagged"
                      : ""
                  }`}
                  key={`${color}-${appIndex}`}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="fps-help-desktop">
          <div className="fps-desktop-screen">
            <div className="fps-tracker-grid">
              {Array.from({ length: 9 }).map((_, index) => (
                <span className="fps-tracker-app" key={index} />
              ))}
            </div>
            <div className="fps-notification fps-help-notification">
              <span className="fps-profile-alert-icon" />
              <strong>{helpTitle}</strong>
              <span>{helpDetail}</span>
            </div>
          </div>
          <div className="fps-desktop-stand" />
        </div>
        <span className="fps-app-stream fps-app-stream--one" />
        <span className="fps-app-stream fps-app-stream--two" />
        <span className="fps-app-stream fps-app-stream--three" />
      </div>
    );
  }

  return (
    <span aria-hidden="true" className="welcome-card-icon">
      {PURPOSE_ICONS[purpose]}
    </span>
  );
}
