import assert from "node:assert/strict";
import test from "node:test";
import { POST as resolvePreview } from "../../app/api/feature-flags/resolve-preview/route";
import { getSetting, setSetting } from "../../lib/scheduler";

/**
 * POST /api/feature-flags/resolve-preview resolves the curated toggle flags
 * against an IN-PROGRESS focus selection so FeatureToggleRow's baseline tracks
 * the goals being edited rather than the last-saved focus (review finding #4).
 * It must be read-only (persist nothing) and reject a bad audience.
 */

function post(body: unknown) {
  return resolvePreview(
    new Request("http://127.0.0.1/api/feature-flags/resolve-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as Parameters<typeof resolvePreview>[0]
  );
}

test("resolve-preview rejects an invalid audience with 400", async () => {
  const res = await post({ audience: "nobody", monitor: true });
  assert.equal(res.status, 400);
});

test("resolve-preview reflects the in-progress goals and persists nothing (#4)", async () => {
  const focusKeys = [
    "flag.focus.audience",
    "flag.focus.goal.monitor",
    "flag.focus.goal.cleanup",
    "flag.focus.goal.minimal",
    "flag.focus.goal.accessibility",
  ];
  const prior = new Map(focusKeys.map((k) => [k, getSetting(k, "")]));
  try {
    // Persisted focus = self + monitor (Stats on). The preview asks for a
    // DIFFERENT (minimal) selection and must reflect THAT, not the persisted one.
    setSetting("flag.focus.audience", "self");
    setSetting("flag.focus.goal.monitor", "true");
    setSetting("flag.focus.goal.cleanup", "false");
    setSetting("flag.focus.goal.minimal", "false");
    setSetting("flag.focus.goal.accessibility", "false");

    const res = await post({
      audience: "self",
      monitor: false,
      cleanup: false,
      minimal: true,
      accessibility: false,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { focusValues: Record<string, string> };
    // 'Keep it minimal' turns Stats + Compare off — even though the PERSISTED
    // focus (monitor) leaves them on. Proves the baseline tracks the edit.
    assert.equal(body.focusValues["flag.page.stats"], "off");
    assert.equal(body.focusValues["flag.page.compare"], "off");

    // Read-only: the persisted focus is untouched by the preview resolve.
    assert.equal(getSetting("flag.focus.goal.monitor", ""), "true");
    assert.equal(getSetting("flag.focus.goal.minimal", ""), "false");
  } finally {
    for (const [k, v] of prior) {
      setSetting(k, v);
    }
  }
});
