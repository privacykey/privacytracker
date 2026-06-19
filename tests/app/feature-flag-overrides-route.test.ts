import assert from "node:assert/strict";
import test from "node:test";
import { DELETE as deleteOverride } from "../../app/api/feature-flags/overrides/[key]/route";
import { POST as postOverride } from "../../app/api/feature-flags/overrides/route";
import { GET as listFlags } from "../../app/api/feature-flags/route";
import { getSetting, setSetting } from "../../lib/scheduler";

interface FlagRow {
  currentValue: string;
  key: string;
  override: string | null;
}

async function flagRow(key: string): Promise<FlagRow | undefined> {
  const res = await listFlags();
  const body = (await res.json()) as { flags: FlagRow[] };
  return body.flags.find((f) => f.key === key);
}

/**
 * The feature-toggle row (FeatureToggleRow) reads resolved values from
 * GET /api/feature-flags and writes per-flag overrides via POST/DELETE
 * /api/feature-flags/overrides. This pins that exact round-trip: write an
 * override, see it reflected (override wins last in the resolver), clear it,
 * see it gone.
 */
test("feature-toggle override round-trips through the API (write → resolve → clear)", async () => {
  const focusKeys = [
    "flag.focus.audience",
    "flag.focus.goal.monitor",
    "flag.focus.goal.cleanup",
    "flag.focus.goal.minimal",
    "flag.focus.goal.accessibility",
  ];
  const prior = new Map(focusKeys.map((k) => [k, getSetting(k, "")]));
  const KEY = "flag.page.compare";
  try {
    // Clean baseline focus: self + no goals → compare resolves to its
    // hard default ("on") with no override.
    setSetting("flag.focus.audience", "self");
    setSetting("flag.focus.goal.monitor", "false");
    setSetting("flag.focus.goal.cleanup", "false");
    setSetting("flag.focus.goal.minimal", "false");
    setSetting("flag.focus.goal.accessibility", "false");

    const before = await flagRow(KEY);
    assert.equal(before?.override, null);
    assert.equal(before?.currentValue, "on");

    // Flip it off via an override (what the toggle button does).
    const postRes = await postOverride(
      new Request("http://127.0.0.1/api/feature-flags/overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: KEY, value: "off" }),
      }) as Parameters<typeof postOverride>[0]
    );
    assert.equal(postRes.status, 200);

    const afterWrite = await flagRow(KEY);
    assert.equal(afterWrite?.override, "off");
    assert.equal(afterWrite?.currentValue, "off");

    // Reset (what the per-row ↺ control does).
    const delRes = await deleteOverride(
      new Request(
        `http://127.0.0.1/api/feature-flags/overrides/${encodeURIComponent(KEY)}`,
        { method: "DELETE" }
      ) as Parameters<typeof deleteOverride>[0],
      { params: Promise.resolve({ key: KEY }) }
    );
    assert.equal(delRes.status, 200);

    const afterClear = await flagRow(KEY);
    assert.equal(afterClear?.override, null);
    assert.equal(afterClear?.currentValue, "on");
  } finally {
    for (const [k, v] of prior) {
      setSetting(k, v);
    }
    // Belt-and-braces: ensure no override lingers for other tests.
    await deleteOverride(
      new Request(
        `http://127.0.0.1/api/feature-flags/overrides/${encodeURIComponent(KEY)}`,
        { method: "DELETE" }
      ) as Parameters<typeof deleteOverride>[0],
      { params: Promise.resolve({ key: KEY }) }
    );
  }
});
