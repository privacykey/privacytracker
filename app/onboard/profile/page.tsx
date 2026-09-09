import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import PrivacyProfileSetupLoader from "../../components/PrivacyProfileSetupLoader";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("onboard_profile_title"),
  };
}

/**
 * Optional privacy-profile step between the Welcome splash and the main
 * import wizard.
 *
 * Rust-core Phase 0: the audience bounce to /welcome, the two
 * profile-setup flags (whose "both off" case bounces to /onboard), both
 * saved profiles and the recommended-preset derivation moved into
 * PrivacyProfileSetupLoader. The audience check still keys off the RAW
 * stored value — `audienceSet` from /api/focus — because the resolved
 * focus returns 'self' as a no-storage default, which would otherwise
 * let users bypass /welcome.
 */
export default function PrivacyProfileOnboardPage() {
  return <PrivacyProfileSetupLoader />;
}
