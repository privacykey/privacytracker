"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { groupForSection, SETTINGS_GROUPS } from "./section-groups";

/**
 * Sends /dashboard/settings to the group route that owns whatever anchor
 * the visitor arrived with.
 *
 * This has to run on the client. A URL fragment is never sent to the
 * server, so Next cannot see `#ai-summaries` and a server redirect would
 * silently drop it — and old anchors are a documented contract:
 * `/privacy-policy` links to `#ai-summaries`, and bell notifications to
 * `#ai-timeouts`.
 *
 * `router.replace` rather than `push`, so Back returns to wherever the
 * visitor came from instead of bouncing through this redirect again.
 */
export default function SettingsLandingRedirect() {
  const router = useRouter();

  useEffect(() => {
    const raw = window.location.hash.replace(/^#/, "");

    // `#ai-timeouts` is an anchor *inside* the Developer Options section
    // rather than a section of its own, so it has no taxonomy entry. Map
    // it to its owning section's group by hand and keep the original
    // anchor, which is what the pulse effect looks for.
    const owningSection = raw === "ai-timeouts" ? "developer" : raw;
    const group = owningSection ? groupForSection(owningSection) : null;

    if (group) {
      router.replace(`/dashboard/settings/${group}#${raw}`);
      return;
    }
    router.replace(`/dashboard/settings/${SETTINGS_GROUPS[0]}`);
  }, [router]);

  return null;
}
