"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import LoaderError from "./LoaderError";

/**
 * Client-side replacement for the server-side empty-install bounce
 * (`getAllApps().length === 0 → redirect("/onboard")`) that most
 * dashboard pages used to run in their server component.
 *
 * Phase 0 of the Rust-core migration (core/README.md) converts pages to
 * client-fetching shells so they no longer read the database in a server
 * component — this gate is the shared piece of that pattern. It asks the API whether any apps exist
 * (`/api/apps?limit=1` returns the `{ total }` envelope) and either
 * renders its children or replaces the location.
 *
 * A FAILED read is not an empty install. The first port copied the old
 * server page's `try { getAllApps() } catch` and treated a failure as
 * "no apps", which sent a user with a full library to onboarding
 * whenever the read hiccuped. It now shows a retryable error instead;
 * only a read that succeeds with a zero total bounces.
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
  const [state, setState] = useState<"checking" | "ready" | "failed">(
    "checking"
  );
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    setState("checking");
    fetch("/api/apps?limit=1")
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
      )
      .then(({ total }: { total: number }) => {
        if (!live) {
          return;
        }
        if (typeof total !== "number") {
          throw new Error("Invalid apps count");
        }
        if (total > 0) {
          setState("ready");
        } else {
          router.replace(redirectTo);
        }
      })
      .catch((error) => {
        console.warn("[apps-gate] could not read the app count:", error);
        if (live) {
          setState("failed");
        }
      });
    return () => {
      live = false;
    };
  }, [router, redirectTo, retry]);

  if (state === "failed") {
    return <LoaderError onRetry={() => setRetry((value) => value + 1)} />;
  }
  return state === "ready" ? children : null;
}
