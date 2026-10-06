import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { GET as loadTriage } from "../../app/api/triage/route";
import { POST as saveVerdict } from "../../app/api/verdicts/route";
import { CANONICAL_ORDER, reconcileLayout } from "../../lib/dashboard-layout";
import {
  getDashboardLayout,
  setDashboardLayout,
} from "../../lib/dashboard-layout-server";
import db from "../../lib/db";
import { getActiveFocus, setActiveFocus } from "../../lib/feature-flag-storage";
import {
  clearDeferral,
  deferDecision,
  getFocusOverview,
  getReviewDecisions,
  hasAcceptedConcern,
} from "../../lib/focus-review";
import { getSetting, setSetting } from "../../lib/scheduler";

beforeEach(() => {
  db.prepare("DELETE FROM apps").run();
  db.prepare("DELETE FROM app_settings").run();
  db.prepare(
    "INSERT INTO apps (id, name, url, lastSynced) VALUES ('focus-app', 'Focus App', 'https://apps.apple.com/app/id1', 100)"
  ).run();
  db.prepare(
    "INSERT INTO privacy_types (id, app_id, identifier, title) VALUES ('focus-type','focus-app','DATA_USED_TO_TRACK_YOU','Tracking')"
  ).run();
  db.prepare(
    "INSERT INTO privacy_categories (id,type_id,identifier,title) VALUES ('focus-category','focus-type','CONTACT_INFO','Contact Info')"
  ).run();
});

const save = (body: object) =>
  saveVerdict(
    new NextRequest("http://localhost/api/verdicts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

test("Minimal retains goals and focus changes reorder custom layouts unless fixed", () => {
  const focus = {
    audience: "self" as const,
    monitor: true,
    cleanup: true,
    minimal: true,
    accessibility: false,
  };
  const custom = {
    v: 1 as const,
    order: [...CANONICAL_ORDER].reverse(),
    hidden: ["activity_section" as const],
  };
  setDashboardLayout(custom);
  setActiveFocus(focus);
  assert.deepEqual(
    [...getActiveFocus().goals],
    ["monitor", "cleanup", "minimal"]
  );
  assert.deepEqual(getDashboardLayout().order.slice(0, 3), [
    "focus_strip",
    "hero",
    "review_section",
  ]);
  assert.deepEqual(getDashboardLayout().hidden, custom.hidden);
  setDashboardLayout({ ...custom, keepFixed: true });
  setActiveFocus({ ...focus, monitor: false });
  assert.deepEqual(getDashboardLayout(), { ...custom, keepFixed: true });
  setDashboardLayout({ ...custom, keepFixed: false });
  setActiveFocus({ ...focus, monitor: false }); // Saving unchanged focus preserves an arrangement.
  assert.deepEqual(getDashboardLayout().order, custom.order);
  setActiveFocus({ ...focus, monitor: true });
  assert.equal(getDashboardLayout().order[0], "focus_strip");
  assert.equal(
    reconcileLayout({ ...custom, keepFixed: "true" }).keepFixed,
    undefined
  );
});

test("Helping someone defaults to a saved handoff even with Minimal", () => {
  setActiveFocus({
    audience: "loved_one",
    monitor: false,
    cleanup: true,
    minimal: true,
    accessibility: false,
  });
  assert.equal(getSetting("flag.focus.workflow"), "other_handoff");
});

test("dashboard cleanup candidates honor Keep and Decide later while raw risk counts remain factual", async () => {
  const read = async (overview = true) =>
    (
      await loadTriage(
        new Request(
          `http://localhost/api/triage${overview ? "?overview=1" : ""}`
        )
      )
    ).json();
  assert.equal((await read()).higherRisk.length, 1);
  await save({ appId: "focus-app", verdict: "safe", acceptCurrent: true });
  assert.equal((await read()).higherRisk.length, 0);
  assert.equal((await read()).highRiskCount, 1);
  assert.equal((await read(false)).higherRisk.length, 1);
  await save({ appId: "focus-app", verdict: "replace" });
  await save({ appId: "focus-app", deferDays: 7 });
  assert.equal((await read()).higherRisk.length, 0);
  setSetting("review.defer.focus-app", String(Date.now() - 1));
  assert.equal((await read()).higherRisk.length, 1);
});

test("Keep accepts the current concern; removals stay accepted, additions and profile changes reopen it", async () => {
  assert.equal(
    (await save({ appId: "focus-app", verdict: "safe", acceptCurrent: true }))
      .status,
    201
  );
  assert.equal(hasAcceptedConcern("focus-app"), true);
  assert.deepEqual(getReviewDecisions().acceptedAppIds, ["focus-app"]);
  db.prepare(
    "DELETE FROM privacy_categories WHERE id = 'focus-category'"
  ).run();
  assert.equal(hasAcceptedConcern("focus-app"), true);
  db.prepare(
    "INSERT INTO privacy_categories (id,type_id,identifier,title) VALUES ('new-category','focus-type','LOCATION','Location')"
  ).run();
  assert.equal(hasAcceptedConcern("focus-app"), false);
  assert.deepEqual(getReviewDecisions().reopenedAppIds, ["focus-app"]);
  // Editing the rationale must not quietly accept a new concern.
  await save({
    appId: "focus-app",
    verdict: "safe",
    rationale: "Still checking",
  });
  assert.equal(hasAcceptedConcern("focus-app"), false);
  await save({ appId: "focus-app", verdict: "safe", acceptCurrent: true });
  assert.equal(hasAcceptedConcern("focus-app"), true);
  await save({ appId: "focus-app", verdict: "safe", clearAcceptance: true });
  assert.equal(hasAcceptedConcern("focus-app"), false);
  await save({ appId: "focus-app", verdict: "safe", acceptCurrent: true });
  setSetting("privacy_profile", JSON.stringify({ location: "none" }));
  assert.equal(hasAcceptedConcern("focus-app"), false);
});

test("Decide later survives reads, becomes due, and a later decision clears the reminder", async () => {
  const until = deferDecision("focus-app", 7, 1000);
  assert.deepEqual(getReviewDecisions(undefined, until - 1).deferredAppIds, [
    "focus-app",
  ]);
  assert.deepEqual(getReviewDecisions(undefined, until).reopenedAppIds, [
    "focus-app",
  ]);
  assert.equal(getFocusOverview(undefined, undefined, until - 1).dueCount, 0);
  assert.equal(getFocusOverview(undefined, undefined, until).dueCount, 1);
  assert.equal(
    getFocusOverview(undefined, undefined, until).apps[0].decision,
    "due"
  );
  assert.equal((await save({ appId: "focus-app", deferDays: 0 })).status, 400);
  assert.equal((await save({ appId: "missing", deferDays: 7 })).status, 404);
  await save({ appId: "focus-app", verdict: "replace" });
  const overview = getFocusOverview(undefined, undefined, until);
  assert.equal(overview.dueCount, 0);
  assert.equal(overview.replacementCount, 1);
  assert.equal(overview.apps[0].decision, "replace");
  clearDeferral("focus-app"); // idempotent
});

test("Overview counts the whole fleet while limiting previews, excludes archived changes and respects scope", () => {
  for (let i = 0; i < 12; i++) {
    db.prepare(
      "INSERT INTO apps(id,name,url,lastSynced,changeCount) VALUES (?,?,?,?,1)"
    ).run(`app-${i}`, `App ${i}`, `https://apps.apple.com/app/id${i + 2}`, 100);
    db.prepare(
      "INSERT INTO privacy_snapshots(id,app_id,scraped_at,snapshot_json,changes_detected,changes_summary,source) VALUES (?,?,200,'[]',1,'[]',?)"
    ).run(`snapshot-${i}`, `app-${i}`, i === 0 ? "wayback" : "live");
  }
  const overview = getFocusOverview(undefined, 150, 300);
  assert.equal(overview.apps.length, 8);
  assert.equal(overview.pendingChanges, 12);
  assert.equal(overview.newChanges, 11);
  assert.equal(getFocusOverview().newChanges, null);
  assert.deepEqual(
    getFocusOverview(
      {
        v: 1,
        mode: "subset",
        deviceIds: ["unknown-device"],
        includeUnattached: false,
      },
      150,
      300
    ),
    {
      apps: [],
      pendingChanges: 0,
      newChanges: 0,
      dueCount: 0,
      replacementCount: 0,
    }
  );
});
