"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AccessibilityProfile } from "@/lib/accessibility-profile";
import type { Audience } from "@/lib/feature-flag-rules";
import { type FocusWorkflow, isFocusWorkflow } from "@/lib/focus-workflow";
import { recommendedPrivacyPresetForFocus } from "@/lib/onboarding-purpose";
import type { PrivacyProfile, ProfilePresetKey } from "@/lib/privacy-profile";
import { useFlagBundle, useFlagBundleStatus } from "@/lib/use-flag-bundle";
import PrivacyProfileSetup from "./PrivacyProfileSetup";

/**
 * Client loader for /onboard/profile (Rust-core Phase 0).
 *
 * Replaces five server reads and two redirects:
 *  - the raw `flag.focus.audience` check that bounced to /welcome
 *    (now `audienceSet` from GET /api/focus),
 *  - the two `flag.onboarding.*_profile_setup` flags, whose combined
 *    "both off" case bounced to /onboard (shared flag fetch),
 *  - the saved privacy + accessibility profiles (their existing GET
 *    twins), and
 *  - `recommendedPrivacyPresetForFocus(focus, workflow)`, which stays a
 *    local call: `lib/onboarding-purpose` is pure (no DB), so it just
 *    needs the focus values that /api/focus already returns.
 *
 * The setup form is held until everything lands — it seeds its editors
 * from these props, so mounting with placeholders and swapping later
 * would either be ignored or overwrite a user's first clicks.
 *
 * Flag-read failure keeps BOTH setup steps visible, matching the server
 * version's `catch { return { privacy: true, accessibility: true } }`.
 */

const SETUP_FLAGS = [
  "flag.onboarding.privacy_profile_setup",
  "flag.onboarding.accessibility_profile_setup",
] as const;

export default function PrivacyProfileSetupLoader() {
  const router = useRouter();
  const flags = useFlagBundle(SETUP_FLAGS);
  // useFlagBundle fails CLOSED (every key false on error), but this
  // page's server gate failed OPEN — its try/catch returned
  // `{ privacy: true, accessibility: true }`, so an unreadable flag kept
  // both steps visible. Without this, a transient /api/feature-flags
  // failure would bounce the user to /onboard and silently skip the
  // step where the privacy profile gets created.
  const { failedToLoad } = useFlagBundleStatus();
  const [ready, setReady] = useState(false);
  // Tracked separately from `ready` so the flag-driven redirect can wait
  // for the audience answer (see the ordering note below).
  const [audienceOk, setAudienceOk] = useState<boolean | null>(null);
  const [profile, setProfile] = useState<PrivacyProfile | null>(null);
  const [a11yProfile, setA11yProfile] = useState<AccessibilityProfile | null>(
    null
  );
  const [recommendedPreset, setRecommendedPreset] =
    useState<ProfilePresetKey | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/api/focus").then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
      ),
      fetch("/api/privacy-profile")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
      fetch("/api/accessibility-profile")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    ])
      .then(([focus, privacyJson, a11yJson]) => {
        if (!live) {
          return;
        }
        if (focus.audienceSet) {
          setAudienceOk(true);
        } else {
          setAudienceOk(false);
          router.replace("/welcome");
          return;
        }
        // Rebuild the shape `recommendedPrivacyPresetForFocus` expects:
        // an audience plus a Set of active goal names.
        const goals = new Set<string>();
        for (const goal of ["monitor", "cleanup", "minimal", "accessibility"]) {
          if (focus[goal]) {
            goals.add(goal);
          }
        }
        const workflow: FocusWorkflow | null = isFocusWorkflow(
          focus.workflow ?? ""
        )
          ? (focus.workflow as FocusWorkflow)
          : null;
        setRecommendedPreset(
          recommendedPrivacyPresetForFocus(
            { audience: (focus.audience ?? "self") as Audience, goals },
            workflow
          )
        );
        setProfile(privacyJson?.profile ?? null);
        setA11yProfile(a11yJson?.profile ?? null);
        setReady(true);
      })
      .catch((error) => {
        console.warn("[onboard/profile] load failed:", error);
        if (live) {
          setAudienceOk(false);
          router.replace("/welcome");
        }
      });
    return () => {
      live = false;
    };
  }, [router]);

  const showPrivacySetup =
    failedToLoad || flags?.["flag.onboarding.privacy_profile_setup"];
  const showAccessibilitySetup =
    failedToLoad || flags?.["flag.onboarding.accessibility_profile_setup"];

  useEffect(() => {
    // Ordering: the server checked the audience FIRST and only then the
    // flags, so an audience-less visitor went to /welcome, not /onboard.
    // Client-side both reads resolve in parallel, so this redirect waits
    // for the audience answer — otherwise a both-flags-off result could
    // fire first and send a first-time visitor on an extra hop.
    if (
      audienceOk === true &&
      flags &&
      !(failedToLoad || showPrivacySetup || showAccessibilitySetup)
    ) {
      router.replace("/onboard");
    }
  }, [
    audienceOk,
    flags,
    failedToLoad,
    showPrivacySetup,
    showAccessibilitySetup,
    router,
  ]);

  // Hold the whole subtree until every value is final: PrivacyProfileSetup
  // seeds its editable state from these props via useState INITIALISERS,
  // so a later prop change is ignored forever — a returning user's saved
  // profile would be silently discarded, and Save would PUT the empty
  // payload over it. `recommendedPreset` matters here too: null selects a
  // different UI branch (no Activate button), not just different copy.
  if (!(ready && (flags || failedToLoad))) {
    return null;
  }
  if (!(showPrivacySetup || showAccessibilitySetup)) {
    return null;
  }
  return (
    <PrivacyProfileSetup
      initialA11yProfile={a11yProfile}
      initialProfile={profile}
      recommendedPreset={recommendedPreset}
      showAccessibilitySetup={Boolean(showAccessibilitySetup)}
      showPrivacySetup={Boolean(showPrivacySetup)}
    />
  );
}
