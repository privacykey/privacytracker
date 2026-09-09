"use client";

import { notFound } from "next/navigation";
import type { FlagKey } from "@/lib/feature-flag-rules";
import { useFlagBundleStatus, useResolvedFlag } from "@/lib/use-flag-bundle";

/**
 * Client-side replacement for the server-side page gate
 * `resolveFlagFromDb(key) !== "on" → notFound()`.
 *
 * Phase 0 of the Rust-core migration (core/README.md on the rust-core
 * branch): pages stop reading the flag resolver in a server component
 * and read the same resolved values from `GET /api/feature-flags`,
 * through the shared `useFlagBundle` fetch — so a page that gates AND
 * reads a flag bundle still makes one request.
 *
 * `notFound()` works in a client component, but only when thrown during
 * render — hence the resolved value coming from state rather than being
 * awaited inline. Children stay unmounted until the flag resolves on,
 * so a gated-off visitor never sees the page flash in first.
 *
 * A failed flag read renders the 404 rather than the page: these gates
 * exist to hide surfaces that shouldn't exist for this install, and
 * "couldn't tell" should not fall open (useFlagBundle fails closed).
 */
export default function RequireFlagGate({
  children,
  flag,
  failOpen = false,
}: {
  children: React.ReactNode;
  flag: FlagKey;
  /**
   * Render the children when the flag can't be read, instead of the 404.
   *
   * Only for gates whose SERVER implementation already defaulted to
   * visible — the dashboard layout editor is the worked example: its
   * resolver call was wrapped in a try/catch returning `true`, because
   * "a feature whose default is on rendering anyway" beats "mysteriously
   * 404s". Everything else stays fail-closed.
   *
   * Note this only covers an unreadable flag; a flag that resolves
   * `off` still 404s either way.
   */
  failOpen?: boolean;
}) {
  const on = useResolvedFlag(flag);
  const { failedToLoad } = useFlagBundleStatus();

  if (failedToLoad && failOpen) {
    return children;
  }
  if (on === false) {
    notFound();
  }
  return on ? children : null;
}
