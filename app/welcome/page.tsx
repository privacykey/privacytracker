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
 * Pre-wizard splash. Captures the user's audience; goals come on the next
 * screen (`/onboard/goals`). Pre-selects the previous audience on re-entry
 * (Settings → Adjust, or browser-back from /onboard/goals) so the card
 * stays highlighted. Checks `flag.focus.audience` directly because
 * `getActiveFocus()` returns 'self' as a default-when-unset.
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
          monitor: focus.goals.has("monitor"),
          cleanup: focus.goals.has("cleanup"),
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
