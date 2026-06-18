import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { isValidAgeBand } from "@/lib/age-rating";
import {
  getActiveFocus,
  getActiveFocusWorkflow,
} from "@/lib/feature-flag-storage";
import { getSetting } from "@/lib/scheduler";
import WelcomeSplash from "../components/WelcomeSplash";

export const dynamic = "force-dynamic";

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
  const focus = (() => {
    try {
      return getActiveFocus();
    } catch {
      return null;
    }
  })();

  // Empty-string default tells "not yet written" apart from a stored 'self'.
  const audienceStored = getSetting("flag.focus.audience", "") !== "";

  const initialFocus =
    audienceStored && focus
      ? {
          audience: focus.audience,
          understand: focus.goals.has("understand"),
          declutter: focus.goals.has("declutter"),
          minimal: focus.goals.has("minimal"),
          accessibility: focus.goals.has("accessibility"),
          workflow: getActiveFocusWorkflow(focus),
        }
      : null;

  const storedBand = getSetting("guardian_child_age_band", "");

  return (
    <WelcomeSplash
      initialChildAgeBand={isValidAgeBand(storedBand) ? storedBand : null}
      initialFocus={initialFocus}
    />
  );
}
