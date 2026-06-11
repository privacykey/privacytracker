/**
 * Pure-logic tests for the user-tasks resolver. No DB; we feed
 * `resolveTasks` a hand-built focus + completion context + state blob and
 * assert on the resolved state per task.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { activeGoalsFrom, type FocusState } from "../lib/feature-flag-rules";
import {
  getOptInCandidates,
  isAllSettled,
  resolveTasks,
  TASK_DEFS,
  type TaskCompletionContext,
  type UserTaskId,
} from "../lib/tasks";

function focus(opts: {
  audience?: FocusState["audience"];
  understand?: boolean;
  declutter?: boolean;
  minimal?: boolean;
  accessibility?: boolean;
  aiConfigured?: boolean;
}): FocusState {
  return {
    audience: opts.audience ?? "self",
    goals: activeGoalsFrom({
      understand: opts.understand ?? false,
      declutter: opts.declutter ?? false,
      minimal: opts.minimal ?? false,
      accessibility: opts.accessibility ?? false,
    }),
    aiConfigured: opts.aiConfigured ?? false,
  };
}

function emptyCtx(
  overrides: Partial<TaskCompletionContext> = {}
): TaskCompletionContext {
  return {
    focus: overrides.focus ?? focus({}),
    workflow: overrides.workflow ?? "custom",
    hasPrivacyProfile: false,
    anyAppDetailVisitedAt: null,
    auditBundleLastExportedAt: null,
    privacyMapVisitedAt: null,
    compareVisitedAt: null,
    verdictCount: 0,
    uninstallVerdictCount: 0,
    backgroundWizardCompletedAt: null,
    syncSchedule: null,
    hasDeviceWithApps: false,
    lastResyncAt: 0,
    ...overrides,
  };
}

const NOW = 1_700_000_000_000; // arbitrary fixed epoch for deterministic tests

test("TASK_DEFS has the nine expected task ids in order", () => {
  const ids = TASK_DEFS.map((d) => d.id);
  assert.deepEqual(ids, [
    "view_privacy_map",
    "open_any_app_detail",
    "create_privacy_profile",
    "review_mismatches",
    "compare_two_apps",
    "setup_background_mode",
    "remove_apps_from_phone",
    "resync_apps_from_device",
    "export_audit_bundle",
  ] satisfies UserTaskId[]);
});

test("every TASK_DEF has a unique id", () => {
  const seen = new Set<UserTaskId>();
  for (const d of TASK_DEFS) {
    assert.ok(!seen.has(d.id), `duplicate task id ${d.id}`);
    seen.add(d.id);
  }
});

test("default self audience with no goals: universal tasks only, no declutter/understand-only ones", () => {
  const f = focus({}); // self + understand silent default
  const ctx = emptyCtx({ focus: f });
  const resolved = resolveTasks(
    f,
    ctx,
    { tasks: {} },
    { isDesktop: false },
    NOW
  );
  const ids = new Set(resolved.map((r) => r.id));
  // activeGoalsFrom defaults to {understand} when no goal is set — that lets
  // compare_two_apps in, but review_mismatches requires declutter/minimal.
  assert.ok(ids.has("view_privacy_map"));
  assert.ok(ids.has("open_any_app_detail"));
  assert.ok(ids.has("create_privacy_profile"));
  assert.ok(ids.has("compare_two_apps"));
  assert.ok(!ids.has("review_mismatches"));
  assert.ok(!ids.has("setup_background_mode"));
});

test("declutter goal adds review_mismatches", () => {
  const f = focus({ declutter: true });
  const ctx = emptyCtx({ focus: f });
  const resolved = resolveTasks(
    f,
    ctx,
    { tasks: {} },
    { isDesktop: false },
    NOW
  );
  assert.ok(resolved.some((r) => r.id === "review_mismatches"));
});

test("minimal goal also enables review_mismatches but suppresses compare (no understand/declutter)", () => {
  const f = focus({ minimal: true });
  const ctx = emptyCtx({ focus: f });
  const resolved = resolveTasks(
    f,
    ctx,
    { tasks: {} },
    { isDesktop: false },
    NOW
  );
  const ids = new Set(resolved.map((r) => r.id));
  assert.ok(ids.has("review_mismatches"));
  assert.ok(!ids.has("compare_two_apps"));
});

test("opt-in tasks (setup_background_mode, remove_apps_from_phone) are hidden until opted in", () => {
  const f = focus({});
  const ctx = emptyCtx({ focus: f });
  // No opt_in markers → both opt-in tasks absent.
  const resolved = resolveTasks(
    f,
    ctx,
    { tasks: {} },
    { isDesktop: false },
    NOW
  );
  assert.ok(!resolved.some((r) => r.id === "setup_background_mode"));
  assert.ok(!resolved.some((r) => r.id === "remove_apps_from_phone"));

  // Add opt-in markers → they appear.
  const optedIn = resolveTasks(
    f,
    ctx,
    {
      tasks: {
        setup_background_mode: { opted_in_at: NOW },
        remove_apps_from_phone: { opted_in_at: NOW },
      },
    },
    { isDesktop: false },
    NOW
  );
  assert.ok(optedIn.some((r) => r.id === "setup_background_mode"));
  assert.ok(optedIn.some((r) => r.id === "remove_apps_from_phone"));
});

test("completionCheck for create_privacy_profile flips on hasPrivacyProfile", () => {
  const f = focus({});
  const open = resolveTasks(
    f,
    emptyCtx({ focus: f, hasPrivacyProfile: false }),
    { tasks: {} },
    { isDesktop: false },
    NOW
  );
  const done = resolveTasks(
    f,
    emptyCtx({ focus: f, hasPrivacyProfile: true }),
    { tasks: {} },
    { isDesktop: false },
    NOW
  );
  assert.equal(
    open.find((r) => r.id === "create_privacy_profile")!.state,
    "ready"
  );
  assert.equal(
    done.find((r) => r.id === "create_privacy_profile")!.state,
    "completed"
  );
});

test("review_mismatches is blocked when create_privacy_profile is not done", () => {
  const f = focus({ declutter: true });
  const ctx = emptyCtx({ focus: f, hasPrivacyProfile: false });
  const resolved = resolveTasks(
    f,
    ctx,
    { tasks: {} },
    { isDesktop: false },
    NOW
  );
  const review = resolved.find((r) => r.id === "review_mismatches")!;
  assert.equal(review.state, "blocked");
});

test("review_mismatches unblocks once the profile exists", () => {
  const f = focus({ declutter: true });
  const ctx = emptyCtx({ focus: f, hasPrivacyProfile: true });
  const resolved = resolveTasks(
    f,
    ctx,
    { tasks: {} },
    { isDesktop: false },
    NOW
  );
  const review = resolved.find((r) => r.id === "review_mismatches")!;
  assert.equal(review.state, "ready");
});

test("started_at within 14 days surfaces as in_progress", () => {
  const f = focus({});
  const ctx = emptyCtx({ focus: f });
  const blob = {
    tasks: {
      view_privacy_map: { started_at: NOW - 1 * 24 * 60 * 60 * 1000 },
    },
  };
  const resolved = resolveTasks(f, ctx, blob, { isDesktop: false }, NOW);
  const view = resolved.find((r) => r.id === "view_privacy_map")!;
  assert.equal(view.state, "in_progress");
});

test("staleness fallback: started_at >14 days ago without completion reverts to ready", () => {
  const f = focus({});
  const ctx = emptyCtx({ focus: f });
  const blob = {
    tasks: {
      view_privacy_map: { started_at: NOW - 15 * 24 * 60 * 60 * 1000 },
    },
  };
  const resolved = resolveTasks(f, ctx, blob, { isDesktop: false }, NOW);
  const view = resolved.find((r) => r.id === "view_privacy_map")!;
  assert.equal(view.state, "ready");
});

test("dismissed_at hides via state=dismissed; completion still wins over dismissal", () => {
  const f = focus({});
  const blob = { tasks: { view_privacy_map: { dismissed_at: NOW - 1000 } } };

  // Dismissed but not completed → dismissed
  const ctx1 = emptyCtx({ focus: f });
  const r1 = resolveTasks(f, ctx1, blob, { isDesktop: false }, NOW);
  assert.equal(r1.find((r) => r.id === "view_privacy_map")!.state, "dismissed");

  // Dismissed AND completed → completed wins (the user did the thing, after all)
  const ctx2 = emptyCtx({ focus: f, privacyMapVisitedAt: NOW - 500 });
  const r2 = resolveTasks(f, ctx2, blob, { isDesktop: false }, NOW);
  assert.equal(r2.find((r) => r.id === "view_privacy_map")!.state, "completed");
});

test("isAllSettled returns true when every task is completed or dismissed", () => {
  const tasks = TASK_DEFS.map((d) => ({
    id: d.id,
    route: d.route,
    prerequisites: d.prerequisites,
    i18nKey: d.i18nKey,
    state: "completed" as const,
    startedAt: null,
    dismissedAt: null,
    optedInAt: null,
    audience: "self" as const,
  }));
  assert.equal(isAllSettled(tasks), true);

  const mixed = tasks.map((t, i) =>
    i === 0 ? { ...t, state: "ready" as const } : t
  );
  assert.equal(isAllSettled(mixed), false);
});

test("isAllSettled returns true for an empty list (nothing to do = settled)", () => {
  assert.equal(isAllSettled([]), true);
});

test("getOptInCandidates surfaces opt-in tasks not yet opted in", () => {
  const f = focus({});
  const ctx = emptyCtx({ focus: f });
  const candidates = getOptInCandidates(
    f,
    ctx,
    { tasks: {} },
    { isDesktop: false }
  );
  const ids = candidates.map((c) => c.id);
  assert.ok(ids.includes("setup_background_mode"));
  assert.ok(ids.includes("remove_apps_from_phone"));
  assert.ok(!ids.includes("export_audit_bundle"));
});

test("getOptInCandidates omits tasks the user has already opted in to", () => {
  const f = focus({});
  const ctx = emptyCtx({ focus: f });
  const candidates = getOptInCandidates(
    f,
    ctx,
    { tasks: { setup_background_mode: { opted_in_at: NOW } } },
    { isDesktop: false }
  );
  const ids = candidates.map((c) => c.id);
  assert.ok(!ids.includes("setup_background_mode"));
  assert.ok(ids.includes("remove_apps_from_phone"));
});

test("getOptInCandidates omits opt-in tasks already completed via derived state", () => {
  const f = focus({});
  // Either signal completes setup_background_mode: wizard done OR a
  // non-manual sync schedule.
  const ctx = emptyCtx({ focus: f, syncSchedule: "weekly" });
  const candidates = getOptInCandidates(
    f,
    ctx,
    { tasks: {} },
    { isDesktop: false }
  );
  const ids = candidates.map((c) => c.id);
  assert.ok(!ids.includes("setup_background_mode"));
});

test("setup_background_mode completes when sync_schedule != manual OR wizard completed", () => {
  const f = focus({});
  const optedIn = { tasks: { setup_background_mode: { opted_in_at: NOW } } };

  const ctx1 = emptyCtx({ focus: f, syncSchedule: "daily" });
  let r = resolveTasks(f, ctx1, optedIn, { isDesktop: false }, NOW);
  assert.equal(
    r.find((x) => x.id === "setup_background_mode")!.state,
    "completed"
  );

  const ctx2 = emptyCtx({ focus: f, backgroundWizardCompletedAt: NOW });
  r = resolveTasks(f, ctx2, optedIn, { isDesktop: false }, NOW);
  assert.equal(
    r.find((x) => x.id === "setup_background_mode")!.state,
    "completed"
  );

  const ctx3 = emptyCtx({ focus: f, syncSchedule: "manual" });
  r = resolveTasks(f, ctx3, optedIn, { isDesktop: false }, NOW);
  assert.equal(r.find((x) => x.id === "setup_background_mode")!.state, "ready");
});

test("remove_apps_from_phone is blocked without a privacy profile (universal prereq)", () => {
  const f = focus({});
  const optedIn = { tasks: { remove_apps_from_phone: { opted_in_at: NOW } } };

  const noProfile = emptyCtx({ focus: f, hasPrivacyProfile: false });
  let r = resolveTasks(f, noProfile, optedIn, { isDesktop: false }, NOW);
  assert.equal(
    r.find((x) => x.id === "remove_apps_from_phone")!.state,
    "blocked"
  );

  const withProfile = emptyCtx({ focus: f, hasPrivacyProfile: true });
  r = resolveTasks(f, withProfile, optedIn, { isDesktop: false }, NOW);
  assert.equal(
    r.find((x) => x.id === "remove_apps_from_phone")!.state,
    "ready"
  );
});

test("remove_apps_from_phone completes once at least one uninstall verdict is set", () => {
  const f = focus({});
  const ctx = emptyCtx({
    focus: f,
    hasPrivacyProfile: true,
    uninstallVerdictCount: 2,
  });
  const r = resolveTasks(
    f,
    ctx,
    { tasks: { remove_apps_from_phone: { opted_in_at: NOW } } },
    { isDesktop: false },
    NOW
  );
  assert.equal(
    r.find((x) => x.id === "remove_apps_from_phone")!.state,
    "completed"
  );
});

test("export_audit_bundle appears only for handoff workflow and completes after export", () => {
  const f = focus({ audience: "loved_one", understand: true, declutter: true });
  const noWorkflow = emptyCtx({ focus: f, workflow: "other_monitor" });
  let candidates = getOptInCandidates(
    f,
    noWorkflow,
    { tasks: {} },
    { isDesktop: false }
  );
  assert.ok(!candidates.some((c) => c.id === "export_audit_bundle"));

  const handoff = emptyCtx({ focus: f, workflow: "other_handoff" });
  candidates = getOptInCandidates(
    f,
    handoff,
    { tasks: {} },
    { isDesktop: false }
  );
  assert.ok(candidates.some((c) => c.id === "export_audit_bundle"));

  const optedIn = {
    tasks: { export_audit_bundle: { opted_in_at: NOW } },
  };
  let resolved = resolveTasks(f, handoff, optedIn, { isDesktop: false }, NOW);
  assert.equal(
    resolved.find((x) => x.id === "export_audit_bundle")!.state,
    "ready"
  );

  resolved = resolveTasks(
    f,
    emptyCtx({
      focus: f,
      workflow: "other_handoff",
      auditBundleLastExportedAt: NOW,
    }),
    optedIn,
    { isDesktop: false },
    NOW
  );
  assert.equal(
    resolved.find((x) => x.id === "export_audit_bundle")!.state,
    "completed"
  );
});
