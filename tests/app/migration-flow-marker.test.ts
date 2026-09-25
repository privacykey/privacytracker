/**
 * The migration-flow marker only ever hands out a path inside the app,
 * and a restore never writes the marker.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { POST as consume } from "../../app/api/migration-flow/consume/route";
import { restoreBackup } from "../../lib/backup";
import { isSameOriginPath } from "../../lib/same-origin-path";
import { getSetting, setSetting } from "../../lib/scheduler";

const SAME_ORIGIN = [
  "/",
  "/dashboard/review-recommendations",
  "/dashboard?edit=layout#top",
  "/%2F%2Fexample.test",
  "/a/../b",
  "/apps/café",
];
const OFF_ORIGIN = [
  "",
  "dashboard",
  "//example.test/",
  "///example.test/",
  "/\\example.test/",
  "/dash\\board",
  "/\t/example.test/",
  "/\n/example.test/",
  "/\r/example.test/",
  "/ /example.test/",
  "/\u007f",
  "/\u0000",
  "https://example.test/",
  "javascript:alert(1)",
];

test("isSameOriginPath accepts only paths that stay inside the app", () => {
  for (const path of SAME_ORIGIN) {
    assert.equal(isSameOriginPath(path), true, JSON.stringify(path));
  }
  for (const path of OFF_ORIGIN) {
    assert.equal(isSameOriginPath(path), false, JSON.stringify(path));
  }
  assert.equal(isSameOriginPath(undefined), false);
  assert.equal(isSameOriginPath(42), false);
});

async function consumeMarker(targetPath: string) {
  setSetting(
    "migration_flow_pending",
    JSON.stringify({ recommenderName: "Bob", targetPath })
  );
  const response = await consume(
    new Request("http://127.0.0.1:3000/api/migration-flow/consume", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.40" },
    }) as never
  );
  assert.equal(response.status, 200);
  return (await response.json()) as { targetPath?: string };
}

test("the consume route never hands out a path that leaves the app", async () => {
  for (const path of ["//example.test/", "/\\example.test/", "/\t/x.test"]) {
    const body = await consumeMarker(path);
    assert.equal(body.targetPath, "/dashboard/review-recommendations");
    assert.equal(getSetting("migration_flow_pending", ""), "");
  }
  const kept = await consumeMarker("/dashboard/review-recommendations?step=2");
  assert.equal(kept.targetPath, "/dashboard/review-recommendations?step=2");
});

test("a restore never writes the migration marker", () => {
  const result = restoreBackup(
    {
      version: 1,
      exportedAt: 1,
      tables: {
        app_settings: {
          rows: [
            {
              key: "migration_flow_pending",
              value: '{"targetPath":"/dashboard"}',
            },
            { key: "sync_schedule", value: "weekly" },
          ],
        },
      },
    },
    { allowUntrusted: true }
  );
  assert.equal(getSetting("migration_flow_pending", ""), "");
  assert.equal(getSetting("sync_schedule", ""), "weekly");
  assert.deepEqual(
    result.blocked.find((b) => b.name === "app_settings"),
    { name: "app_settings", rows: 1 }
  );
});
