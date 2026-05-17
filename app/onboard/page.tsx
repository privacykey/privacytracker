import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";
import { getSetting } from "@/lib/scheduler";
import { detectDeviceFromUA } from "../../lib/device";
import OnboardWizard from "../components/OnboardWizard";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("onboard_title"),
  };
}

export const dynamic = "force-dynamic";

/**
 * Gate the import wizard behind the welcome splash — if the user lands here
 * by typing the URL directly before picking an audience, bounce them to
 * /welcome so the dashboard tailoring has something to key off later. The
 * welcome splash + goals screen are what set the focus state and route here.
 *
 * Round 3 PR 2: gate on `flag.focus.audience` (the new audience key) instead
 * of the legacy `user_intent` (now removed by the migration).
 *
 * We also sniff the User-Agent server-side so the wizard can render the
 * correct device-specific method cards in the initial HTML — no flash of
 * the wrong option while JS boots. The client then refines the guess via
 * `refineDeviceOnClient` using viewport width + touch points.
 */
export default async function OnboardPage() {
  const audienceSet = getSetting("flag.focus.audience", "") !== "";
  if (!audienceSet) {
    redirect("/welcome");
  }

  // `headers()` is async in Next 15/16 (still works synchronously in 14);
  // await covers both without a runtime branch.
  const hdrs = await Promise.resolve(headers() as any);
  const userAgent =
    typeof hdrs?.get === "function"
      ? (hdrs.get("user-agent") as string | null)
      : null;
  const initialDevice = detectDeviceFromUA(userAgent);
  const flags = {
    methodConfigurator: safeResolveOn("flag.onboarding.method.configurator"),
  };

  return <OnboardWizard flags={flags} initialDevice={initialDevice} />;
}

function safeResolveOn(key: Parameters<typeof resolveFlagFromDb>[0]): boolean {
  try {
    return resolveFlagFromDb(key) === "on";
  } catch {
    return false;
  }
}
