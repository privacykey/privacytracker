import type { Metadata } from "next";
import Link from "next/link";
import FocusFlagMatrix from "@/app/components/FocusFlagMatrix";
import Nav from "@/app/components/Nav";

/**
 * /dashboard/settings/focus-matrix — author the desired flag matrix
 * across every (audience × goals) combination.
 *
 * Spec table covering 12 combos (3 audiences × 4 goal sets) with the
 * resolver value shown as baseline and the user's desired value layered
 * on top. Saving cells persists locally; export as JSON or a draft TS
 * patch ready to paste into AUDIENCE_RULES / GOAL_RULES in
 * `lib/feature-flag-rules.ts`. The JSON is also accepted by
 * `POST /api/feature-flags/overrides`.
 *
 * Per-combo resolution runs client-side in `FocusFlagMatrix.tsx`, so
 * toggling cells re-renders without hitting the API.
 */

export const metadata: Metadata = {
  title: "Focus × Flags matrix — privacytracker",
  description:
    "Author the desired enabled/disabled state of every feature flag for each audience and goal combination.",
};

export default function FocusMatrixPage() {
  return (
    <>
      <Nav />
      <div className="legal-page">
        <header className="legal-page-hero">
          <Link
            className="priv-back-link"
            href="/dashboard/settings/admin#developer"
          >
            ← Back to Developer Options
          </Link>
          <p className="priv-eyebrow">Developer · Authoring</p>
          <h1 className="legal-page-title">Focus × Flags matrix</h1>
          <p className="legal-page-sub">
            Write down what each flag should resolve to for every audience and
            goal combination. The current resolver value is shown faintly as the
            baseline; clicking a cell layers your desired value on top. Nothing
            here changes live behaviour until you click{" "}
            <em>Apply combo as overrides</em> or paste the exported patch into{" "}
            <code>lib/feature-flag-rules.ts</code>.
          </p>
        </header>

        <FocusFlagMatrix />
      </div>
    </>
  );
}
