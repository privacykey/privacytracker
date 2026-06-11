import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAccessibilityProfile } from "@/lib/accessibility-profile-server";
import {
  getActiveFocus,
  getActiveFocusWorkflow,
} from "@/lib/feature-flag-storage";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";
import { recommendedPrivacyPresetForFocus } from "@/lib/onboarding-purpose";
import { getSetting } from "@/lib/scheduler";
import { getPrivacyProfile } from "../../../lib/privacy-profile-server";
import PrivacyProfileSetup from "../../components/PrivacyProfileSetup";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("onboard_profile_title"),
  };
}

export const dynamic = "force-dynamic";

/**
 * Optional privacy-profile step between the Welcome splash and the main
 * import wizard. Loads the saved profile so returning users see their
 * picks, and redirects to /welcome if the focus audience isn't set yet.
 * We check `getSetting` directly because `getActiveFocus()` returns
 * 'self' as a no-storage default, which would let users bypass /welcome.
 */
export default function PrivacyProfileOnboardPage() {
  const audienceSet = getSetting("flag.focus.audience", "") !== "";
  if (!audienceSet) {
    redirect("/welcome");
  }

  // Either profile-setup flag resolving on keeps the page reachable;
  // both off redirects to /onboard so the wizard isn't bypassed.
  const profileSetup = (() => {
    try {
      return {
        privacy:
          resolveFlagFromDb("flag.onboarding.privacy_profile_setup") === "on",
        accessibility:
          resolveFlagFromDb("flag.onboarding.accessibility_profile_setup") ===
          "on",
      };
    } catch {
      return { privacy: true, accessibility: true };
    }
  })();
  if (!(profileSetup.privacy || profileSetup.accessibility)) {
    redirect("/onboard");
  }

  const focus = getActiveFocus();
  const workflow = getActiveFocusWorkflow(focus);
  const initialProfile = getPrivacyProfile();
  const initialA11yProfile = getAccessibilityProfile();
  const recommendedPreset = recommendedPrivacyPresetForFocus(focus, workflow);
  const showPrivacySetup = profileSetup.privacy;
  const showAccessibilitySetup = profileSetup.accessibility;
  if (!(showPrivacySetup || showAccessibilitySetup)) {
    redirect("/onboard");
  }

  return (
    <PrivacyProfileSetup
      initialA11yProfile={initialA11yProfile}
      initialProfile={initialProfile}
      recommendedPreset={recommendedPreset}
      showAccessibilitySetup={showAccessibilitySetup}
      showPrivacySetup={showPrivacySetup}
    />
  );
}
