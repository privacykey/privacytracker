"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { AccessibilityProfile } from "../../lib/accessibility-profile";
import {
  PROFILE_PRESET_META,
  PROFILE_PRESETS,
  type PrivacyProfile,
  type ProfilePresetKey,
} from "../../lib/privacy-profile";
import {
  normaliseProfilePayload,
  type ProfilePromptChoice,
  resolveProfilePromptPayload,
} from "../../lib/profile-setup-prompt";
import AccessibilityProfileEditor from "./AccessibilityProfileEditor";
import PrivacyProfileEditor from "./PrivacyProfileEditor";

interface Props {
  initialA11yProfile: AccessibilityProfile | null;
  initialProfile: PrivacyProfile | null;
  recommendedPreset: ProfilePresetKey | null;
  showAccessibilitySetup: boolean;
  showPrivacySetup: boolean;
}

export default function PrivacyProfileSetup({
  initialA11yProfile,
  initialProfile,
  recommendedPreset,
  showAccessibilitySetup,
  showPrivacySetup,
}: Props) {
  const t = useTranslations("onboard.profile_setup");
  const tPresetLabel = useTranslations(
    "settings.profile_editor.presets.labels"
  );
  const tPresetDescription = useTranslations(
    "settings.profile_editor.presets.descriptions"
  );
  const router = useRouter();

  const recommendedProfile =
    recommendedPreset === null ? null : PROFILE_PRESETS[recommendedPreset];
  const recommendedMeta =
    recommendedPreset === null ? null : PROFILE_PRESET_META[recommendedPreset];
  const recommendedLabel =
    recommendedPreset === null ? "" : tPresetLabel(recommendedPreset);
  const recommendedDescription =
    recommendedPreset === null ? "" : tPresetDescription(recommendedPreset);

  const [privacyChoice, setPrivacyChoice] = useState<ProfilePromptChoice>(null);
  const [a11yEditorOpen, setA11yEditorOpen] = useState(false);
  const [profile, setProfile] = useState<PrivacyProfile>(
    initialProfile && Object.keys(initialProfile).length > 0
      ? { ...initialProfile }
      : { ...(recommendedProfile ?? {}) }
  );
  const [a11yProfile, setA11yProfile] = useState<AccessibilityProfile>(
    initialA11yProfile && Object.keys(initialA11yProfile).length > 0
      ? { ...initialA11yProfile }
      : {}
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const continueToWizard = () => {
    router.push("/onboard");
  };

  function activatePrivacy() {
    if (recommendedProfile) {
      setProfile({ ...recommendedProfile });
    }
    setPrivacyChoice("activate");
  }

  function customisePrivacy() {
    if (Object.keys(profile).length === 0 && recommendedProfile) {
      setProfile({ ...recommendedProfile });
    }
    setPrivacyChoice("customise");
  }

  function customiseA11y() {
    setA11yEditorOpen(true);
  }

  async function saveAndContinue() {
    setSaving(true);
    setError("");
    try {
      if (showPrivacySetup && privacyChoice) {
        const payload = resolveProfilePromptPayload(
          privacyChoice,
          profile,
          recommendedProfile ?? profile
        );
        const res = await fetch("/api/privacy-profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: payload }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? t("save_failed"));
        }
      }

      if (showAccessibilitySetup && a11yEditorOpen) {
        const payload = normaliseProfilePayload(a11yProfile);
        const res = await fetch("/api/accessibility-profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: payload }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? t("save_failed"));
        }
      }

      continueToWizard();
    } catch (err) {
      console.error("[onboard/profile] save failed:", err);
      setError(err instanceof Error ? err.message : t("save_failed"));
      setSaving(false);
    }
  }

  const privacySetCount = Object.values(profile).filter(
    (v) => typeof v === "string"
  ).length;
  const a11ySetCount = Object.values(a11yProfile).filter(
    (v) => typeof v === "string"
  ).length;
  const continueDisabled =
    saving ||
    (privacyChoice === "customise" && privacySetCount === 0) ||
    (a11yEditorOpen && a11ySetCount === 0);
  const hasPendingSave =
    (showPrivacySetup && Boolean(privacyChoice)) ||
    (showAccessibilitySetup && a11yEditorOpen);

  return (
    <div className="wizard-outer">
      <div className="wizard-card wizard-card-wide profile-recommend-card">
        <Link
          aria-label={t("back_aria")}
          className="wizard-back-link"
          href="/welcome"
        >
          <span aria-hidden="true">←</span> {t("back_to_goals")}
        </Link>
        <div className="wizard-subtle-eyebrow">{t("eyebrow")}</div>
        <h1 className="wizard-title">{t("title")}</h1>
        <p className="wizard-subtitle">{t("recommend_subtitle")}</p>

        {showPrivacySetup && (
          <section className="profile-recommend-section">
            <div className="profile-recommend-header">
              <div>
                <h2>
                  {recommendedMeta
                    ? t("privacy_recommend_title")
                    : t("privacy_intro_title")}
                </h2>
                <p>
                  {recommendedMeta
                    ? t("privacy_recommend_body", {
                        preset: recommendedLabel,
                      })
                    : t("privacy_intro_body")}
                </p>
              </div>
              {recommendedMeta ? (
                <span
                  className={`profile-recommend-badge ${recommendedMeta.severityCls}`}
                >
                  {recommendedLabel}
                </span>
              ) : (
                <span className="profile-recommend-badge severity-unlinked">
                  {t("privacy_badge")}
                </span>
              )}
            </div>
            <p className="profile-recommend-description">
              {recommendedMeta
                ? recommendedDescription
                : t("privacy_intro_description")}
            </p>
            {recommendedMeta ? (
              <ChoiceButtons
                activateLabel={t("activate_preset", {
                  preset: recommendedLabel,
                })}
                choice={privacyChoice}
                customiseLabel={t("customise")}
                disabled={saving}
                disableLabel={t("disable")}
                onActivate={activatePrivacy}
                onCustomise={customisePrivacy}
                onDisable={() => setPrivacyChoice("disable")}
              />
            ) : (
              <div className="profile-recommend-actions">
                <button
                  className={`btn btn-secondary ${privacyChoice === "customise" ? "is-selected" : ""}`}
                  disabled={saving}
                  onClick={customisePrivacy}
                  type="button"
                >
                  {t("customise_privacy")}
                </button>
                <button
                  className={`btn btn-ghost ${privacyChoice === "disable" ? "is-selected" : ""}`}
                  disabled={saving}
                  onClick={() => setPrivacyChoice("disable")}
                  type="button"
                >
                  {t("disable")}
                </button>
              </div>
            )}
            {privacyChoice === "customise" && (
              <PrivacyProfileEditor
                confirmOnPresetApply={false}
                disabled={saving}
                onChange={setProfile}
                value={profile}
              />
            )}
          </section>
        )}

        {showAccessibilitySetup && (
          <section className="profile-recommend-section">
            <div className="profile-recommend-header">
              <div>
                <h2>{t("a11y_customise_title")}</h2>
                <p>{t("a11y_customise_body")}</p>
              </div>
              <span className="profile-recommend-badge severity-unlinked">
                {t("a11y_badge")}
              </span>
            </div>
            <p className="profile-recommend-description">
              {t("a11y_customise_description")}
            </p>
            {!a11yEditorOpen && (
              <div className="profile-recommend-actions">
                <button
                  className="btn btn-secondary"
                  disabled={saving}
                  onClick={customiseA11y}
                  type="button"
                >
                  {t("customise_a11y")}
                </button>
              </div>
            )}
            {a11yEditorOpen && (
              <AccessibilityProfileEditor
                disabled={saving}
                onChange={setA11yProfile}
                value={a11yProfile}
              />
            )}
          </section>
        )}

        {error && (
          <div className="welcome-error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        <div className="welcome-actions" style={{ marginTop: 16 }}>
          <button
            className="btn btn-primary"
            disabled={continueDisabled}
            onClick={() => void saveAndContinue()}
            type="button"
          >
            {saving
              ? t("saving")
              : hasPendingSave
                ? t("save_continue")
                : t("continue")}
          </button>
          <button
            className="btn btn-ghost welcome-skip"
            disabled={saving}
            onClick={continueToWizard}
            type="button"
          >
            {t("skip")}
          </button>
        </div>

        <p className="welcome-footnote" style={{ marginTop: 14 }}>
          {t("footnote_pre")}
          <Link
            className="welcome-link"
            href="/dashboard/settings#privacy-profile"
          >
            {t("footnote_link")}
          </Link>
          {t("footnote_post")}
        </p>
      </div>
    </div>
  );
}

function ChoiceButtons({
  activateLabel,
  choice,
  customiseLabel,
  disabled,
  disableLabel,
  onActivate,
  onCustomise,
  onDisable,
}: {
  activateLabel: string;
  choice: ProfilePromptChoice;
  customiseLabel: string;
  disabled: boolean;
  disableLabel: string;
  onActivate: () => void;
  onCustomise: () => void;
  onDisable: () => void;
}) {
  return (
    <div className="profile-recommend-actions">
      <button
        className={`btn btn-secondary ${choice === "activate" ? "is-selected" : ""}`}
        disabled={disabled}
        onClick={onActivate}
        type="button"
      >
        {activateLabel}
      </button>
      <button
        className={`btn btn-ghost ${choice === "customise" ? "is-selected" : ""}`}
        disabled={disabled}
        onClick={onCustomise}
        type="button"
      >
        {customiseLabel}
      </button>
      <button
        className={`btn btn-ghost ${choice === "disable" ? "is-selected" : ""}`}
        disabled={disabled}
        onClick={onDisable}
        type="button"
      >
        {disableLabel}
      </button>
    </div>
  );
}
