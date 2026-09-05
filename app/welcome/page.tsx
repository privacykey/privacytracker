import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import WelcomeLoader from "../components/WelcomeSplashLoader";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("welcome_title"),
  };
}

/**
 * Pre-wizard splash. Captures the user's audience AND goals in a single
 * step via FocusPurposeForm (the same form the Settings focus editor
 * reuses) — there is no separate goals screen; `/onboard/goals` is now a
 * redirect stub to `/welcome?customize=1`. Pre-fills the previous focus on
 * re-entry (Settings → Adjust) so the cards stay highlighted. Checks
 * `flag.focus.audience` directly because `getActiveFocus()` returns 'self'
 * as a default-when-unset.
 */
export default function WelcomePage() {
  return <WelcomeLoader />;
}
