"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Three-way landing:
 *   - Has apps                    → /dashboard
 *   - No apps, no audience picked → /welcome (pre-wizard audience picker)
 *   - No apps, audience picked    → /onboard (the existing 5-step import flow)
 *
 * Phase 0 of the Rust-core migration: this used to be a server component
 * reading the DB directly (`getAllApps()` + the raw `flag.focus.audience`
 * setting). It now decides client-side from the API — `/api/apps?limit=1`
 * for the app count and the `audienceSet` field on `GET /api/focus`
 * (added for exactly this page: the resolved focus always has an
 * audience, so the raw has-the-user-ever-chosen signal needs its own
 * field). Any failure falls back to /welcome, which renders without any
 * pre-existing state — the same fallback the server version used for an
 * uninitialised DB.
 */
export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/api/apps?limit=1").then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
      ),
      fetch("/api/focus").then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
      ),
    ])
      .then(([apps, focus]: [{ total: number }, { audienceSet?: boolean }]) => {
        if (!live) {
          return;
        }
        if (apps.total > 0) {
          router.replace("/dashboard");
        } else {
          router.replace(focus.audienceSet ? "/onboard" : "/welcome");
        }
      })
      .catch(() => {
        if (live) {
          router.replace("/welcome");
        }
      });
    return () => {
      live = false;
    };
  }, [router]);

  return null;
}
