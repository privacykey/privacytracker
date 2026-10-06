import assert from "node:assert/strict";
import { test } from "node:test";
import { DashboardVisits } from "../../lib/dashboard-visit";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}
const key = "privacytracker.dashboard.visit.all";

test("review navigation and reload keep the baseline; a new tab starts at the last successful view", () => {
  const history = storage();
  const session = storage();
  history.setItem(key, "100");
  const tab = new DashboardVisits(
    () => history,
    () => session
  );
  const visit = tab.begin(null, 200);
  tab.record(visit, 210);
  assert.equal(tab.begin(null, 300).since, 100);
  const reloaded = new DashboardVisits(
    () => history,
    () => session
  );
  const returned = reloaded.begin(null, 400);
  assert.equal(returned.since, 100);
  reloaded.record(returned, 410);
  const newSession = storage();
  const newTab = new DashboardVisits(
    () => history,
    () => newSession
  );
  assert.equal(newTab.begin(null, 500).since, 410);
  // Another tab recording a successful visit does not move this tab's baseline.
  newTab.record(newTab.begin(null, 500), 510);
  assert.equal(reloaded.begin(null, 600).since, 100);
});

test("device views have independent baselines, including a first visit", () => {
  const history = storage();
  const session = storage();
  history.setItem(key, "100");
  history.setItem("privacytracker.dashboard.visit.phone", "150");
  const tab = new DashboardVisits(
    () => history,
    () => session
  );
  assert.equal(tab.begin(null, 200).since, 100);
  assert.equal(tab.begin("phone", 200).since, 150);
  const first = tab.begin("tablet", 200);
  assert.equal(first.since, null);
  tab.record(first, 220);
  const reload = new DashboardVisits(
    () => history,
    () => session
  );
  assert.equal(reload.begin("tablet", 300).since, null);
  assert.equal(tab.begin(null, 300).since, 100);
});

test("an unsuccessful dashboard read never advances the saved visit", () => {
  const history = storage();
  const session = storage();
  history.setItem(key, "100");
  const tab = new DashboardVisits(
    () => history,
    () => session
  );
  tab.begin(null, 200); // No record: the read fails or redirects to onboarding.
  assert.equal(history.getItem(key), "100");
  assert.equal(session.getItem(key), null);
  const reload = new DashboardVisits(
    () => history,
    () => session
  );
  assert.equal(reload.begin(null, 300).since, 100);
});

test("corrupt session state falls back to valid history; unavailable storage keeps in-memory continuity", () => {
  const history = storage();
  history.setItem(key, "100");
  for (const invalid of [
    "{",
    "null",
    '{"v":1,"since":300,"startedAt":200}',
    '{"v":1,"since":100,"startedAt":900}',
  ]) {
    const session = storage();
    session.setItem(key, invalid);
    const tab = new DashboardVisits(
      () => history,
      () => session
    );
    assert.equal(tab.begin(null, 400).since, 100);
  }
  const blocked = () => {
    throw new Error("Storage unavailable");
  };
  const tab = new DashboardVisits(() => history, blocked);
  const visit = tab.begin(null, 200);
  tab.record(visit, 210);
  assert.equal(tab.begin(null, 300).since, 100);
  const privateTab = new DashboardVisits(blocked, blocked);
  const first = privateTab.begin(null, 200);
  assert.equal(first.since, null);
  assert.doesNotThrow(() => privateTab.record(first, 210));
  assert.equal(privateTab.begin(null, 300), first);
});
