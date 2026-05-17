import { redirect } from "next/navigation";
import { getSetting } from "../lib/scheduler";
import { getAllApps } from "../lib/scraper";

export const dynamic = "force-dynamic";

/**
 * Three-way landing:
 *   - Has apps                    → /dashboard
 *   - No apps, no audience picked → /welcome (pre-wizard audience picker)
 *   - No apps, audience picked    → /onboard (the existing 5-step import flow)
 *
 * Round 3 PR 2: switched from the legacy `user_intent` key to the new
 * `flag.focus.audience` key (the v1 migration rewrote intent to audience).
 * Read tolerates a missing DB by falling back to /welcome.
 */
export default function RootPage() {
  let hasApps = false;
  let audienceSet = false;
  try {
    const apps = getAllApps() as any[];
    hasApps = apps.length > 0;
    audienceSet = getSetting("flag.focus.audience", "") !== "";
  } catch (error) {
    // DB not yet initialised — send to welcome, which doesn't need any
    // pre-existing state to render.
    console.warn("[root] DB read failed, routing to /welcome:", error);
  }

  if (hasApps) {
    redirect("/dashboard");
  }
  redirect(audienceSet ? "/onboard" : "/welcome");
}
