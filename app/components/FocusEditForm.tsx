"use client";

/**
 * FocusEditForm — single-screen audience + goals editor for the
 * "Adjust" flow off the Settings YourFocusCard.
 *
 * Spec: https://privacytracker-docs.privacykey.org/develop/feature-flags ("Post-onboarding: changing
 * audience or goals"). Submitting the form does NOT write to the DB —
 * it stages a session-scoped preview via lib/focus-preview.ts. The
 * user then sees the persistent banner above every page and chooses
 * "Keep these changes" (commits) or "Revert" (drops).
 *
 * Both axes live on one screen rather than the full two-step
 * onboarding, because the user is editing a known existing focus, not
 * choosing fresh. Pre-fills from the current DB-stored focus.
 *
 * Accessibility: WCAG AA. Audience cards form a `radiogroup` with
 * arrow-key roving, mirroring WelcomeSplash. Goal cards are
 * independently selectable `role="checkbox"`. The "Just the basics"
 * alternative is mutually exclusive with understand/declutter and
 * disables them when active. Accessibility modifier is independent.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type KeyboardEvent, useState } from "react";
import type { Audience } from "@/lib/feature-flag-rules";
import { setPreviewFocus } from "@/lib/focus-preview";
import AccessibilityFigureGlyph from "./AccessibilityFigureGlyph";

/**
 * Audience cards. Labels + subtext live in `locales/en.json` under
 * `audience.<value>.{label,subtext}` — kept in sync with WelcomeSplash
 * so copy edits flow through both surfaces. Only the icon stays
 * hard-coded here because emoji glyphs are language-agnostic.
 */
const AUDIENCE_VALUES: ReadonlyArray<{ value: Audience; icon: string }> = [
  { value: "self", icon: "👤" },
  { value: "loved_one", icon: "🤝" },
  { value: "guardian", icon: "🛡️" },
];

interface Props {
  initialAccessibility: boolean;
  initialAudience: Audience;
  initialDeclutter: boolean;
  initialMinimal: boolean;
  initialUnderstand: boolean;
}

export default function FocusEditForm({
  initialAudience,
  initialUnderstand,
  initialDeclutter,
  initialMinimal,
  initialAccessibility,
}: Props) {
  const router = useRouter();
  // Translation namespaces wired to locales/en.json. We pull copy from
  // four namespaces:
  //   - `focus_edit`   → page-specific chrome (headings, buttons)
  //   - `audience`     → audience card labels (shared w/ WelcomeSplash)
  //   - `goal`         → goal card labels    (shared w/ GoalsScreen)
  //   - `your_focus_card` is read by the parent server page; not here.
  const t = useTranslations("focus_edit");
  const tAudience = useTranslations("audience");
  const tGoal = useTranslations("goal");
  const [audience, setAudience] = useState<Audience>(initialAudience);
  const [understand, setUnderstand] = useState(initialUnderstand);
  const [declutter, setDeclutter] = useState(initialDeclutter);
  const [minimal, setMinimal] = useState(initialMinimal);
  const [accessibility, setAccessibility] = useState(initialAccessibility);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState("");

  // ─── Audience radiogroup keyboard nav ──────────────────────────────
  function focusAudienceCard(value: Audience) {
    document.getElementById(`focus-audience-card-${value}`)?.focus();
  }

  function handleAudienceKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      const next = (index + 1) % AUDIENCE_VALUES.length;
      setAudience(AUDIENCE_VALUES[next].value);
      focusAudienceCard(AUDIENCE_VALUES[next].value);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      const prev =
        (index - 1 + AUDIENCE_VALUES.length) % AUDIENCE_VALUES.length;
      setAudience(AUDIENCE_VALUES[prev].value);
      focusAudienceCard(AUDIENCE_VALUES[prev].value);
    }
  }

  // ─── Goal toggles ──────────────────────────────────────────────────
  function handleToggleUnderstand() {
    if (minimal) {
      return;
    }
    setUnderstand((prev) => !prev);
  }

  function handleToggleDeclutter() {
    if (minimal) {
      return;
    }
    setDeclutter((prev) => !prev);
  }

  function handleToggleMinimal() {
    const next = !minimal;
    setMinimal(next);
    if (next) {
      setUnderstand(false);
      setDeclutter(false);
      setAnnouncement(t("minimal_announce_on"));
    } else {
      setAnnouncement(t("minimal_announce_off"));
    }
  }

  function handleSavePreview() {
    // Apply silent default per §4.2: empty primary goals → understand.
    let finalUnderstand = understand;
    const finalDeclutter = declutter;
    if (!(minimal || understand || declutter)) {
      finalUnderstand = true;
    }
    try {
      setPreviewFocus({
        audience,
        understand: finalUnderstand,
        declutter: finalDeclutter,
        minimal,
        accessibility,
      });
    } catch (e) {
      console.error("[FocusEditForm] failed to stage preview", e);
      setError(t("stage_failed"));
      return;
    }
    // Route back to Settings — the global FocusPreviewBanner now appears
    // at the top of every page until the user commits or reverts.
    router.push("/dashboard/settings#focus");
  }

  function handleCancel() {
    router.push("/dashboard/settings#focus");
  }

  return (
    <div className="wizard-outer">
      <div className="wizard-card wizard-card-wide focus-edit-card">
        <h1 className="wizard-title">{t("page_title")}</h1>
        <p className="wizard-subtitle">{t("subtitle")}</p>

        {/* ── Audience axis ─────────────────────────────────────────── */}
        <h2 className="focus-edit-axis-heading">{t("audience_heading")}</h2>
        <div
          aria-label={t("audience_aria")}
          className="method-grid welcome-grid audience-grid"
          role="radiogroup"
        >
          {AUDIENCE_VALUES.map((option, index) => {
            const isSelected = audience === option.value;
            return (
              <button
                aria-checked={isSelected}
                className={`method-card welcome-card audience-card ${isSelected ? "active" : ""}`}
                id={`focus-audience-card-${option.value}`}
                key={option.value}
                onClick={() => setAudience(option.value)}
                onKeyDown={(e) => handleAudienceKeyDown(e, index)}
                role="radio"
                tabIndex={isSelected ? 0 : -1}
                type="button"
              >
                <div className="method-card-top">
                  <span aria-hidden="true" className="welcome-card-icon">
                    {option.icon}
                  </span>
                  <span aria-hidden="true" className="method-card-radio">
                    {isSelected ? "✓" : ""}
                  </span>
                </div>
                <div className="method-card-title">
                  {tAudience(`${option.value}.label`)}
                </div>
                <p className="method-card-copy">
                  {tAudience(`${option.value}.subtext`)}
                </p>
              </button>
            );
          })}
        </div>

        {/* ── Goals axis ────────────────────────────────────────────── */}
        <h2 className="focus-edit-axis-heading focus-edit-axis-heading--spaced">
          {t("goals_heading")}
        </h2>
        <div
          aria-label={t("goals_aria")}
          className="method-grid welcome-grid goals-grid"
          role="group"
        >
          <button
            aria-checked={understand}
            aria-describedby="focus-goal-understand-subtext"
            aria-disabled={minimal}
            className={`method-card welcome-card goal-card ${understand ? "active" : ""} ${minimal ? "is-disabled" : ""}`}
            onClick={handleToggleUnderstand}
            role="checkbox"
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
            <div className="method-card-title">{tGoal("understand.label")}</div>
            <p className="method-card-copy" id="focus-goal-understand-subtext">
              {tGoal("understand.subtext")}
            </p>
          </button>

          <button
            aria-checked={declutter}
            aria-describedby="focus-goal-declutter-subtext"
            aria-disabled={minimal}
            className={`method-card welcome-card goal-card ${declutter ? "active" : ""} ${minimal ? "is-disabled" : ""}`}
            onClick={handleToggleDeclutter}
            role="checkbox"
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
            <div className="method-card-title">{tGoal("declutter.label")}</div>
            <p className="method-card-copy" id="focus-goal-declutter-subtext">
              {tGoal("declutter.subtext")}
            </p>
          </button>
        </div>

        <div aria-hidden="true" className="goals-divider">
          {t("or_divider")}
        </div>

        <div className="method-grid welcome-grid goals-grid goals-grid-minimal">
          <button
            aria-checked={minimal}
            aria-describedby="focus-goal-minimal-subtext"
            className={`method-card welcome-card goal-card goal-card-minimal ${minimal ? "active" : ""}`}
            onClick={handleToggleMinimal}
            role="radio"
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
            <p className="method-card-copy" id="focus-goal-minimal-subtext">
              {tGoal("minimal.subtext")}
            </p>
          </button>
        </div>

        <div className="goals-modifier">
          <button
            aria-checked={accessibility}
            aria-describedby="focus-goal-a11y-subtext"
            className={`method-card welcome-card goal-card goal-card-modifier ${accessibility ? "active" : ""}`}
            onClick={() => setAccessibility((prev) => !prev)}
            role="checkbox"
            type="button"
          >
            <div className="method-card-top">
              {/* Accessibility-figure SVG instead of the wheelchair
                  pictogram — same glyph the footer trigger and detail
                  chip use, so onboarding picks up the right vocabulary. */}
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
            <p className="method-card-copy" id="focus-goal-a11y-subtext">
              {tGoal("accessibility.subtext")}
            </p>
          </button>
        </div>

        <div aria-live="polite" className="sr-only" role="status">
          {announcement}
        </div>

        {error && (
          <div aria-live="assertive" className="welcome-error" role="alert">
            {error}
          </div>
        )}

        <div className="welcome-actions focus-edit-actions">
          <button
            className="btn btn-ghost"
            onClick={handleCancel}
            type="button"
          >
            {t("cancel")}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSavePreview}
            type="button"
          >
            {t("save")}
          </button>
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
