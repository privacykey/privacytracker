import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/export/audit-bundle/route";
import { getSetting, setSetting } from "../lib/scheduler";
import { resetTestDb } from "./test-db";

test.beforeEach(resetTestDb);

function postAuditBundle(body: unknown) {
  return POST(
    new Request("http://127.0.0.1/api/export/audit-bundle", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
      },
      body: JSON.stringify(body),
    }) as Parameters<typeof POST>[0]
  );
}

test("audit bundle export is allowed for other_handoff workflow and stamps completion", async () => {
  setSetting("flag.focus.audience", "self");
  setSetting("flag.focus.goal.understand", "true");
  setSetting("flag.focus.goal.declutter", "false");
  setSetting("flag.focus.goal.minimal", "false");
  setSetting("flag.focus.goal.accessibility", "false");
  setSetting("flag.focus.workflow", "other_handoff");

  const res = await postAuditBundle({ recommenderName: "Tester" });

  assert.equal(res.status, 200);
  const bundle = await res.json();
  assert.equal(bundle.recommender_name, "Tester");
  assert.equal(bundle.exported_by_audience, "self");
  assert.ok(Number(getSetting("audit_bundle_last_exported_at", "")) > 0);
});
