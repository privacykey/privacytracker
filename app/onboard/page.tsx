import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import OnboardGate from "../components/OnboardGate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("onboard_title"),
  };
}

/**
 * Gate the import wizard behind the welcome splash — if the user lands here
 * by typing the URL directly before picking an audience, bounce them to
 * /welcome so the dashboard tailoring has something to key off later. The
 * welcome splash + goals screen are what set the focus state and route here.
 *
 * Round 3 PR 2: gate on `flag.focus.audience` (the new audience key) instead
 * of the legacy `user_intent` (now removed by the migration).
 *
 * Rust-core Phase 0: the audience check, the configurator flag and the
 * User-Agent sniff all moved into OnboardGate (client). See its header
 * for what the UA move costs and why it's safe.
 */
export default function OnboardPage() {
  return <OnboardGate />;
}
