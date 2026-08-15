"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Client-side replacement for the server-side empty-install bounce
 * (`getAllApps().length === 0 → redirect("/onboard")`) that most
 * dashboard pages used to run in their server component.
 *
 * Phase 0 of the Rust-core migration (core/README.md on the rust-core
 * branch) converts pages to client-fetching shells so they no longer
 * read the database in a server component — this gate is the shared
 * piece of that pattern. It asks the API whether any apps exist
 * (`/api/apps?limit=1` returns the `{ total }` envelope) and either
 * renders its children or replaces the location, exactly matching the
 * old server semantics — including treating a failed read as an empty
 * install, which is what the old `try { getAllApps() } catch` did.
 *
 * Children stay unmounted until the check resolves so a to-be-redirected
 * visitor never sees the gated surface flash in.
 */
export default function RequireAppsGate({
  children,
  redirectTo = "/onboard",
}: {
  children: React.ReactNode;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/apps?limit=1")
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
      )
      .then(({ total }: { total: number }) => {
        if (!live) {
          return;
        }
        if (total > 0) {
          setReady(true);
        } else {
          router.replace(redirectTo);
        }
      })
      .catch(() => {
        // DB not ready / fetch failed — same fallback the server pages
        // used: treat as an empty install.
        if (live) {
          router.replace(redirectTo);
        }
      });
    return () => {
      live = false;
    };
  }, [router, redirectTo]);

  return ready ? children : null;
}
