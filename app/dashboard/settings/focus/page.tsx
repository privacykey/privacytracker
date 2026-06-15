import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import FocusEditForm from "@/app/components/FocusEditForm";
import Nav from "@/app/components/Nav";
import { isValidAgeBand } from "@/lib/age-rating";
import {
  getActiveFocus,
  getActiveFocusWorkflow,
} from "@/lib/feature-flag-storage";
import { getSetting } from "@/lib/scheduler";

/**
 * /dashboard/settings/focus — single-screen audience + goals editor
 * for the "Adjust" link off the YourFocusCard. Reads the active focus
 * synchronously from the DB and hands the four boolean flags +
 * audience to the client form, which stages a session-scoped preview
 * rather than committing.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("focus_edit_title"),
    description: t("focus_edit_description"),
  };
}

export default function FocusEditPage() {
  const focus = getActiveFocus();
  // Default to `self` if audience was somehow blank — the radiogroup
  // needs an initial value. Shouldn't be reachable in practice.
  const initialAudience = focus.audience ?? "self";
  const initialWorkflow = getActiveFocusWorkflow(focus);
  const storedBand = getSetting("guardian_child_age_band", "");

  return (
    <>
      <Nav />
      <FocusEditForm
        initialAccessibility={focus.goals.has("accessibility")}
        initialAudience={initialAudience}
        initialChildAgeBand={isValidAgeBand(storedBand) ? storedBand : null}
        initialDeclutter={focus.goals.has("cleanup")}
        initialMinimal={focus.goals.has("minimal")}
        initialUnderstand={focus.goals.has("monitor")}
        initialWorkflow={initialWorkflow}
      />
    </>
  );
}
