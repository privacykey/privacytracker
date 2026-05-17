"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type KeyboardEvent, useEffect, useState } from "react";
import type { Audience } from "@/lib/feature-flag-rules";
import { useFlag } from "../../lib/feature-flags-hooks";
import AccessibilityFigureGlyph from "./AccessibilityFigureGlyph";

/**
 * Onboarding screen 2 — WHY are you using this?
 *
 * Two primary-goal checkboxes (understand, declutter) that can combine,
 * a separate "Just the basics" alternative that is mutually exclusive
 * with the two checkboxes, and an independent accessibility modifier.
 *
 * "Skip" sets `goal.understand = true` silently. If the user ticks only
 * the accessibility modifier, the same silent default kicks in (§4.2).
 *
 * Accessibility: WCAG AA. Native checkboxes for understand/declutter
 * (browser handles keyboard semantics). The "Just the basics" alternative
 * is a `role="radio"`-styled card that disables the checkboxes when
 * picked, with an aria-live announcement for the state change.
 *
 * See https://privacytracker-docs.privacykey.org/develop/feature-flags.
 */

interface Props {
  /** Current audience (set on screen 1). Influences default goals — guardian
   *  pre-selects understand only; loved_one pre-selects understand;
   *  self leaves checkboxes empty (silent default kicks in on Skip). */
  audience: Audience;
  initialAccessibility?: boolean;
  initialDeclutter?: boolean;
  initialMinimal?: boolean;

  /** If revisiting (e.g. via Settings), pre-fill these. */
  initialUnderstand?: boolean;
}

export default function GoalsScreen({
  audience,
  initialUnderstand,
  initialDeclutter,
  initialMinimal,
  initialAccessibility,
}: Props) {
  const router = useRouter();
  // Goals-screen translations. Three namespaces:
  //   - `onboarding.goals` for headline/subhead/buttons/save-error/announce
  //   - `goal` for the four card titles + subtexts (shared across surfaces)
  //   - `common` for the spinner copy
  const t = useTranslations("onboarding.goals");
  const tGoal = useTranslations("goal");
  const tCommon = useTranslations("common");

  // Wave I — onboarding screen-2 sub-flags. The picker itself can be
  // hidden (skipping straight to /onboard with the silent-default
  // `understand: true`); the "Skip" link, the "Just the basics"
  // alternative, and the accessibility-modifier checkbox all gate
  // independently so admins can prune the form to whichever subset
  // matches their audience.
  const goalsPickerOn = useFlag("flag.onboarding.goals_picker") === "on";
  const goalsPickerSkipOn =
    useFlag("flag.onboarding.goals_picker.skip") === "on";
  const goalsPickerMinimalOn =
    useFlag("flag.onboarding.goals_picker.minimal_option") === "on";
  const goalsPickerA11yModifierOn =
    useFlag("flag.onboarding.goals_picker.accessibility_modifier") === "on";

  // Derive initial state from props (revisit case) or fall back to
  // audience-aware defaults for first-time users on screen 2.
  const [understand, setUnderstand] = useState(
    initialUnderstand === undefined ? audience !== "self" : initialUnderstand // loved_one + guardian pre-select understand
  );
  const [declutter, setDeclutter] = useState(initialDeclutter ?? false);
  const [minimal, setMinimal] = useState(initialMinimal ?? false);
  const [accessibility, setAccessibility] = useState(
    initialAccessibility ?? false
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");

  // Sync if the parent re-renders with different initial values.
  useEffect(() => {
    if (initialUnderstand !== undefined) {
      setUnderstand(initialUnderstand);
    }
    if (initialDeclutter !== undefined) {
      setDeclutter(initialDeclutter);
    }
    if (initialMinimal !== undefined) {
      setMinimal(initialMinimal);
    }
    if (initialAccessibility !== undefined) {
      setAccessibility(initialAccessibility);
    }
  }, [
    initialUnderstand,
    initialDeclutter,
    initialMinimal,
    initialAccessibility,
  ]);

  function handleToggleUnderstand(checked: boolean) {
    if (minimal) {
      return; // disabled while minimal is selected
    }
    setUnderstand(checked);
  }

  function handleToggleDeclutter(checked: boolean) {
    if (minimal) {
      return;
    }
    setDeclutter(checked);
  }

  function handleToggleMinimal() {
    const next = !minimal;
    setMinimal(next);
    if (next) {
      // Picking minimal deselects + disables the two primary checkboxes.
      setUnderstand(false);
      setDeclutter(false);
      setAnnouncement(t("minimal_announce_on"));
    } else {
      setAnnouncement(t("minimal_announce_off"));
    }
  }

  function handleToggleAccessibility(checked: boolean) {
    setAccessibility(checked);
  }

  /**
   * Roving-tabindex keyboard handler for the primary-goal cards. Mirrors
   * the audience-picker pattern in WelcomeSplash so keyboard users get
   * Arrow keys → move focus + (where it makes sense) toggle the
   * focused goal. Each `kind` is the discriminator for which card is
   * currently focused; ↑/← and ↓/→ cycle through the three cards
   * (understand → declutter → minimal → understand). Space/Enter
   * activate the focused card via the browser's native button click —
   * we don't preventDefault on those keys so accessibility tools that
   * map activation onto Enter still work.
   */
  type GoalCardKind = "understand" | "declutter" | "minimal";
  const GOAL_ORDER: GoalCardKind[] = ["understand", "declutter", "minimal"];

  function focusGoalCard(kind: GoalCardKind) {
    const id = `goal-card-${kind}`;
    document.getElementById(id)?.focus();
  }

  function handleGoalCardKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    kind: GoalCardKind
  ) {
    if (saving) {
      return;
    }
    const visible = GOAL_ORDER.filter((k) => {
      // Hide minimal from the cycle when its flag is off so users
      // don't get a phantom focus stop on a missing card.
      if (k === "minimal") {
        return goalsPickerMinimalOn;
      }
      return true;
    });
    const index = visible.indexOf(kind);
    if (index === -1) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      const next = (index + 1) % visible.length;
      focusGoalCard(visible[next]);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      const prev = (index - 1 + visible.length) % visible.length;
      focusGoalCard(visible[prev]);
    }
  }

  async function commitAndContinue() {
    // Apply silent default per §4.2: empty primary goals → understand.
    let finalUnderstand = understand;
    const finalDeclutter = declutter;
    if (!(minimal || understand || declutter)) {
      finalUnderstand = true;
    }

    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audience,
          understand: finalUnderstand,
          declutter: finalDeclutter,
          minimal,
          accessibility,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t("save_failed"));
      }
      router.push("/onboard/profile");
    } catch (err) {
      console.error("[goals] save failed:", err);
      setError(err instanceof Error ? err.message : t("save_failed"));
      setSaving(false);
    }
  }

  function handleSkip() {
    // Skip = silent default (understand only). We just commit and continue.
    setUnderstand(true);
    setDeclutter(false);
    setMinimal(false);
    void commitAndContinue();
  }

  function handleBack() {
    router.push("/welcome");
  }

  // Disable Next when minimal is unticked AND no primary goal is checked.
  // (We auto-default to understand on commit, but we visually allow Next
  //  to be clickable in that case — the silent fallback applies on submit.)
  const nextDisabled = saving;

  return (
    <div className="wizard-outer">
      <div className="wizard-card wizard-card-wide">
        <h1 className="wizard-title">{t("headline")}</h1>
        <p className="wizard-subtitle">{t("subhead")}</p>

        {goalsPickerOn && (
          <div
            aria-label={t("primary_goals_aria")}
            className="method-grid welcome-grid goals-grid"
            role="group"
          >
            {/* Understand — toggle. role="checkbox" is correct here:
                understand and declutter are independently selectable
                (you can pick both), unlike audience cards which were
                radios. aria-checked drives the visual `.active` state
                same as the audience cards. */}
            <button
              aria-checked={understand}
              aria-describedby="goal-understand-subtext"
              aria-disabled={minimal || saving}
              className={`method-card welcome-card goal-card ${understand ? "active" : ""} ${minimal ? "is-disabled" : ""}`}
              disabled={saving}
              id="goal-card-understand"
              onClick={() => handleToggleUnderstand(!understand)}
              onKeyDown={(e) => handleGoalCardKeyDown(e, "understand")}
              role="checkbox"
              tabIndex={saving ? -1 : 0}
              type="button"
            >
              <div className="method-card-top">
                <span aria-hidden="true" className="welcome-card-icon">
                  🔍
                </span>
                <span aria-hidden="true" className="method-card-radio">
                  {understand ? "✓" : ""}
                </span>
              </div>
              <div className="method-card-title">
                {tGoal("understand.label")}
              </div>
              <p className="method-card-copy" id="goal-understand-subtext">
                {tGoal("understand.subtext")}
              </p>
            </button>

            {/* Declutter — toggle. */}
            <button
              aria-checked={declutter}
              aria-describedby="goal-declutter-subtext"
              aria-disabled={minimal || saving}
              className={`method-card welcome-card goal-card ${declutter ? "active" : ""} ${minimal ? "is-disabled" : ""}`}
              disabled={saving}
              id="goal-card-declutter"
              onClick={() => handleToggleDeclutter(!declutter)}
              onKeyDown={(e) => handleGoalCardKeyDown(e, "declutter")}
              role="checkbox"
              tabIndex={saving ? -1 : 0}
              type="button"
            >
              <div className="method-card-top">
                <span aria-hidden="true" className="welcome-card-icon">
                  🧹
                </span>
                <span aria-hidden="true" className="method-card-radio">
                  {declutter ? "✓" : ""}
                </span>
              </div>
              <div className="method-card-title">
                {tGoal("declutter.label")}
              </div>
              <p className="method-card-copy" id="goal-declutter-subtext">
                {tGoal("declutter.subtext")}
              </p>
            </button>
          </div>
        )}

        {goalsPickerOn && goalsPickerMinimalOn && (
          <div aria-hidden="true" className="goals-divider">
            {t("or_divider")}
          </div>
        )}

        {goalsPickerOn && goalsPickerMinimalOn && (
          /* Minimal — radio (mutually exclusive with the two above).
             Stays on its own row beneath the divider so the geometry
             reads as "pick zero/one/both above OR pick this". */
          <div className="method-grid welcome-grid goals-grid goals-grid-minimal">
            <button
              aria-checked={minimal}
              aria-describedby="goal-minimal-subtext"
              className={`method-card welcome-card goal-card goal-card-minimal ${minimal ? "active" : ""}`}
              disabled={saving}
              id="goal-card-minimal"
              onClick={handleToggleMinimal}
              onKeyDown={(e) => handleGoalCardKeyDown(e, "minimal")}
              role="radio"
              tabIndex={saving ? -1 : 0}
              type="button"
            >
              <div className="method-card-top">
                <span aria-hidden="true" className="welcome-card-icon">
                  📋
                </span>
                <span aria-hidden="true" className="method-card-radio">
                  {minimal ? "✓" : ""}
                </span>
              </div>
              <div className="method-card-title">{tGoal("minimal.label")}</div>
              <p className="method-card-copy" id="goal-minimal-subtext">
                {tGoal("minimal.subtext")}
              </p>
            </button>
          </div>
        )}

        {goalsPickerOn && goalsPickerA11yModifierOn && (
          /* Accessibility modifier — independent of the three above so
             it sits in its own row below them. role="checkbox"
             matches the underlying behaviour (you can have it on with
             any combination of the primaries, including minimal). */
          <div className="goals-modifier">
            <button
              aria-checked={accessibility}
              aria-describedby="goal-a11y-subtext"
              className={`method-card welcome-card goal-card goal-card-modifier ${accessibility ? "active" : ""}`}
              disabled={saving}
              onClick={() => handleToggleAccessibility(!accessibility)}
              role="checkbox"
              tabIndex={saving ? -1 : 0}
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
                {tGoal("accessibility.label")}
              </div>
              <p className="method-card-copy" id="goal-a11y-subtext">
                {tGoal("accessibility.subtext")}
              </p>
            </button>
          </div>
        )}

        <div aria-live="polite" className="visually-hidden" role="status">
          {announcement}
        </div>

        {error && (
          <div aria-live="assertive" className="welcome-error" role="alert">
            {error}
          </div>
        )}

        <div className="welcome-actions">
          <button
            className="btn btn-ghost"
            disabled={saving}
            onClick={handleBack}
            type="button"
          >
            {t("back")}
          </button>
          <button
            className="btn btn-primary"
            disabled={nextDisabled}
            onClick={() => void commitAndContinue()}
            type="button"
          >
            {saving ? tCommon("saving") : t("next")}
          </button>
          {goalsPickerSkipOn && (
            <button
              className="btn btn-ghost welcome-skip"
              disabled={saving}
              onClick={handleSkip}
              type="button"
            >
              {t("skip")}
            </button>
          )}
        </div>

        <p className="welcome-footnote">
          {t("footnote_prompt")}{" "}
          <Link className="welcome-link" href="/help/focus">
            {t("help_link")}
          </Link>
        </p>
      </div>
    </div>
  );
}
