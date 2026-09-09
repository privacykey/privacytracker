"use client";

import { useEffect } from "react";

/**
 * Fires the first-visit marker that drives checklist completion for the
 * Privacy Map / Compare / App Detail tasks (Rust-core Phase 0).
 *
 * These pages used to stamp `task_visit.<surface>_at` with
 * `setSettingIfUnset` during their server render. As client shells they
 * post it instead; the endpoint keeps the "first visit wins, later calls
 * are no-ops" semantics, so firing on every mount is safe.
 *
 * Renders nothing and never surfaces an error: a missed completion
 * marker must not break the page, which is exactly how the server
 * version behaved (its write was wrapped in try/catch).
 */
export default function RecordTaskVisit({
  surface,
}: {
  surface: "privacy_map" | "compare" | "app_detail";
}) {
  useEffect(() => {
    fetch("/api/user-tasks/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surface }),
    }).catch(() => {
      // Best-effort, exactly like the server-side try/catch it replaces.
    });
  }, [surface]);

  return null;
}
