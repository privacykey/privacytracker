"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Audience } from "@/lib/feature-flag-rules";
import { useFlagBundle } from "@/lib/use-flag-bundle";
import { useDeviceScope, withScopeParam } from "./DeviceScopeProvider";
import LoaderError from "./LoaderError";
import { PageSkeleton } from "./LoadingShell";
import Nav from "./Nav";
import ReviewRecommendationsView from "./ReviewRecommendationsView";

/**
 * Client loader for /dashboard/review-recommendations (Rust-core Phase 0).
 *
 * The page assembled its rows from six DB reads plus a per-row
 * `listAnnotations()`; that whole assembly moved verbatim into
 * `GET /api/review-queue`, so the row shape stays byte-identical to what
 * ReviewRecommendationsView consumes (it captures `rows` into
 * `useState(initialRows)` on mount and ignores later prop changes, so
 * the view is held back until the fetch resolves).
 *
 * The audience and the cfgutil flag are GATE INPUTS, not page gates: the
 * view renders the same apps either way and only hides the destructive
 * Backup/Act steps when they fail. So an unreadable flag must resolve to
 * `false` (hide the destructive path) rather than blocking the page —
 * which is what useFlagBundle's fail-closed default already gives.
 *
 * A failed queue read is NOT an empty install: it renders a retryable
 * error instead of the onboarding bounce, and the bounce also requires an
 * unscoped read, as the grid and the dashboard do (a device with nothing
 * on it legitimately reports zero).
 */
export default function ReviewQueueLoader() {
  const { ready: scopeReady, scopeParam } = useDeviceScope();
  const router = useRouter();
  const flags = useFlagBundle(["flag.devopts.cfgutil_uninstall"]);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState<{
    appCount: number;
    audience: Audience;
    /**
     * "Generated <date>" label for the printable checklist. The server
     * page formatted this once per request so SSR and hydration couldn't
     * disagree on locale defaults and force a wizard rebuild; the same
     * property holds here by formatting it once, when the data lands,
     * and never on re-render.
     */
    generatedAtLabel: string;
    rows: Parameters<typeof ReviewRecommendationsView>[0]["rows"];
    sourceDeviceEcids: Record<string, string[]>;
  } | null>(null);

  useEffect(() => {
    // Held until the device scope lands, then re-fetched whenever it
    // changes — this page describes a set of apps, and which apps it
    // describes is exactly what the scope decides.
    if (!scopeReady) {
      return;
    }
    let live = true;
    setFailed(false);
    Promise.all([
      fetch(withScopeParam("/api/review-queue", scopeParam))
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
      fetch("/api/focus")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    ]).then(([queue, focus]) => {
      if (!live) {
        return;
      }
      if (typeof queue?.total !== "number") {
        setFailed(true);
        return;
      }
      // No apps tracked → punt to onboarding, same as the server page.
      // `total` is the tracked-app count the endpoint reports, and it
      // follows the scope, so only an unscoped zero means an empty
      // install.
      if (queue.total === 0 && !scopeParam) {
        router.replace("/onboard");
        return;
      }
      setData({
        rows: queue.rows ?? [],
        sourceDeviceEcids: queue.sourceDeviceEcids ?? {},
        appCount: queue.total,
        audience: (focus?.audience ?? "self") as Audience,
        generatedAtLabel: new Date().toLocaleString(),
      });
    });
    return () => {
      live = false;
    };
  }, [router, scopeReady, scopeParam, retry]);

  if (failed) {
    return (
      <>
        <Nav />
        <LoaderError onRetry={() => setRetry((value) => value + 1)} />
      </>
    );
  }

  return (
    <>
      <Nav appCount={data?.appCount} />
      {data && flags ? (
        <ReviewRecommendationsView
          audience={data.audience}
          flagOn={flags["flag.devopts.cfgutil_uninstall"]}
          generatedAtLabel={data.generatedAtLabel}
          rows={data.rows}
          sourceDeviceEcids={data.sourceDeviceEcids}
        />
      ) : (
        <PageSkeleton />
      )}
    </>
  );
}
