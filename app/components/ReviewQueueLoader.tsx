"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Audience } from "@/lib/feature-flag-rules";
import { useFlagBundle } from "@/lib/use-flag-bundle";
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
 */
export default function ReviewQueueLoader() {
  const router = useRouter();
  const flags = useFlagBundle(["flag.devopts.cfgutil_uninstall"]);
  const [data, setData] = useState<{
    appCount: number;
    audience: Audience;
    rows: Parameters<typeof ReviewRecommendationsView>[0]["rows"];
    sourceDeviceEcids: Record<string, string[]>;
  } | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/api/review-queue")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
      fetch("/api/focus")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    ]).then(([queue, focus]) => {
      if (!live) {
        return;
      }
      // No apps tracked → punt to onboarding, same as the server page.
      // `total` is the tracked-app count the endpoint reports.
      if (!queue || queue.total === 0) {
        router.replace("/onboard");
        return;
      }
      setData({
        rows: queue.rows ?? [],
        sourceDeviceEcids: queue.sourceDeviceEcids ?? {},
        appCount: queue.total,
        audience: (focus?.audience ?? "self") as Audience,
      });
    });
    return () => {
      live = false;
    };
  }, [router]);

  return (
    <>
      <Nav appCount={data?.appCount} />
      {data && flags ? (
        <ReviewRecommendationsView
          audience={data.audience}
          flagOn={flags["flag.devopts.cfgutil_uninstall"]}
          rows={data.rows}
          sourceDeviceEcids={data.sourceDeviceEcids}
        />
      ) : null}
    </>
  );
}
