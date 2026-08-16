"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AccessibilityProfile } from "@/lib/accessibility-profile";
import type { Audience } from "@/lib/feature-flag-rules";
import { type FocusWorkflow, isFocusWorkflow } from "@/lib/focus-workflow";
import { recommendedPrivacyPresetForFocus } from "@/lib/onboarding-purpose";
import type { PrivacyProfile, ProfilePresetKey } from "@/lib/privacy-profile";
import { useFlagBundle } from "@/lib/use-flag-bundle";
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
  const [ready, setReady] = useState(false);
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
        if (!focus.audienceSet) {
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
          router.replace("/welcome");
        }
      });
    return () => {
      live = false;
    };
  }, [router]);

  const showPrivacySetup = flags?.["flag.onboarding.privacy_profile_setup"];
  const showAccessibilitySetup =
    flags?.["flag.onboarding.accessibility_profile_setup"];

  useEffect(() => {
    if (flags && !(showPrivacySetup || showAccessibilitySetup)) {
      router.replace("/onboard");
    }
  }, [flags, showPrivacySetup, showAccessibilitySetup, router]);

  if (!(ready && flags && (showPrivacySetup || showAccessibilitySetup))) {
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
