import type { Metadata } from "next";
import Link from "next/link";
import FocusFlagMatrix from "@/app/components/FocusFlagMatrix";
import Nav from "@/app/components/Nav";
import {
  type FlagKey,
  type FlagValue,
  HARD_DEFAULTS,
} from "@/lib/feature-flag-rules";

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

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Focus × Flags matrix — privacytracker",
  description:
    "Author the desired enabled/disabled state of every feature flag for each audience and goal combination.",
};

interface SeedRow {
  hardDefault: FlagValue;
  key: FlagKey;
  surface: string;
}

function surfaceOf(key: FlagKey): string {
  const parts = key.split(".");
  return parts.length >= 2 ? parts[1] : "misc";
}

export default function FocusMatrixPage() {
  // Build the seed list from HARD_DEFAULTS so order is deterministic and
  // independent of /api/feature-flags' live override state.
  const rows: SeedRow[] = (Object.keys(HARD_DEFAULTS) as FlagKey[])
    .map((key) => ({
      key,
      surface: surfaceOf(key),
      hardDefault: HARD_DEFAULTS[key],
    }))
    .sort((a, b) =>
      a.surface === b.surface
        ? a.key.localeCompare(b.key)
        : a.surface.localeCompare(b.surface)
    );

  return (
    <>
      <Nav />
      <div className="legal-page">
        <header className="legal-page-hero">
          <Link className="priv-back-link" href="/dashboard/settings#developer">
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

        <FocusFlagMatrix rows={rows} />
      </div>
    </>
  );
}
