import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";
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
  const profileSetupOn = (() => {
    try {
      return (
        resolveFlagFromDb("flag.onboarding.privacy_profile_setup") === "on" ||
        resolveFlagFromDb("flag.onboarding.accessibility_profile_setup") ===
          "on"
      );
    } catch {
      return true;
    }
  })();
  if (!profileSetupOn) {
    redirect("/onboard");
  }

  const initialProfile = getPrivacyProfile();
  return <PrivacyProfileSetup initialProfile={initialProfile} />;
}
