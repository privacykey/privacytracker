/**
 * `/api/activity?type=` must actually filter.
 *
 * The route validated the incoming type against its own hand-maintained
 * allowlist, which had fallen eight entries behind the ActivityType
 * union (profile_preset_applied, verdict_set, migration, …). Because
 * `parseType()` returns undefined for an unrecognised value and an
 * undefined filter means "no filter", the endpoint answered
 * `?type=profile_preset_applied` with the UNFILTERED feed — so a caller
 * asking for one kind of row got whatever happened to be newest.
 *
 * That surfaced as a CI-only e2e failure: locally the periodic health
 * check (60s after boot) had not fired yet, so the newest row happened
 * to be the expected one and the broken filter was invisible.
 *
 * The allowlist is now derived from ACTIVITY_TYPES, so this test guards
 * the property that mattered rather than the list's contents.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVITY_TYPES } from "../../lib/activity";

test("every ActivityType is accepted by the /api/activity type filter", async () => {
  const routeSrc = await import("node:fs").then((fs) =>
    fs.readFileSync(
      new URL("../../app/api/activity/route.ts", import.meta.url),
      "utf8"
    )
  );

  // The route must derive its allowlist rather than restate it: a
  // literal array here is exactly how the two fell out of sync before.
  assert.ok(
    /KNOWN_TYPES[^=]*=\s*ACTIVITY_TYPES/.test(routeSrc),
    "app/api/activity/route.ts should use ACTIVITY_TYPES as its filter allowlist, not a local copy"
  );
});

test("ACTIVITY_TYPES covers the types the app actually writes", () => {
  // Spot-check the ones whose absence caused the bug — each is written
  // by a real code path (privacy-profile PUT, verdicts, the migration,
  // the health check) and each was missing from the route's old copy.
  for (const written of [
    "profile_preset_applied",
    "dashboard_layout_applied",
    "health_check",
    "verdict_set",
    "verdict_cleared",
    "bulk_verdict_set",
    "migration",
    "annotation_created",
    "queue_session_completed",
    "bundle_imported",
  ]) {
    assert.ok(
      (ACTIVITY_TYPES as readonly string[]).includes(written),
      `${written} is written by the app but missing from ACTIVITY_TYPES`
    );
  }
});
