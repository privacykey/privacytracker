/**
 * Parity manifest — every route in `app/api/**‍/route.ts`, classified.
 *
 * Split out of parity-diff.mjs because it is the part humans argue
 * about: which routes the Rust core must reproduce byte-for-byte, and
 * which ones legitimately can't be replayed in a parity run. The engine
 * is mechanical; this file is the spec.
 *
 * THE COVERAGE RULE: every route.ts under app/api must appear in exactly
 * one of READS / MUTATIONS / QUARANTINE. parity-diff.mjs walks the
 * filesystem and fails if any route is unlisted or listed twice. That is
 * deliberate — the manifest previously covered 17 of 120 routes and
 * nothing noticed as the surface grew from 110 to 120. Adding a route
 * now forces a decision here, in the same PR.
 *
 * ── The four kinds ──────────────────────────────────────────────────
 *
 * READS       GET, replayed against both servers, byte-compared after
 *             normalisation. The strongest signal, and the default.
 *
 *             `transform` narrows what is compared when part of a
 *             response is legitimately machine state (RSS, disk free,
 *             WAL bytes, uptime). Prefer a narrow transform over
 *             quarantining the whole route — comparing a route's shape
 *             and its stable fields still catches most porting bugs.
 *
 * MUTATIONS   Non-GET with a deterministic body. Replayed against both
 *             sides in a fixed order AFTER every read, so they cannot
 *             perturb the read comparisons. The response is compared,
 *             and `after` names a GET whose post-mutation state is then
 *             compared too — a write that returns a plausible 200 but
 *             persists differently is exactly the bug class the Rust
 *             port will produce, and response-only comparison misses it.
 *
 * TEARDOWN    Destructive mutations (reset, wipe, start-over). Same
 *             treatment as MUTATIONS but ordered last, because they
 *             invalidate everything before them.
 *
 * QUARANTINE  Cannot be replayed in-process. Every entry carries a
 *             `why`. These are NOT silently skipped: the engine still
 *             asserts both sides agree on HTTP status, which catches
 *             routing, auth-gate and method-allow drift — just not body
 *             parity. Quarantining is a claim that needs justifying in
 *             review, which is why the reason is a required field.
 */

/** Placeholders resolved per-side at run time by parity-diff.mjs. */
export const PLACEHOLDERS = [
  "{app}",
  "{manualApp}",
  "{device}",
  "{annotation}",
];

// ── READS ────────────────────────────────────────────────────────────

export const READS = [
  // -- core collections
  { route: "/api/apps", name: "apps (bare array)", path: "/api/apps" },
  {
    route: "/api/apps",
    name: "apps (paginated + grid meta)",
    path: "/api/apps?limit=250&offset=0&meta=grid",
  },
  { route: "/api/manual-apps", name: "manual apps", path: "/api/manual-apps" },
  {
    route: "/api/manual-apps/[id]",
    name: "manual app detail",
    path: "/api/manual-apps/{manualApp}",
  },
  { route: "/api/devices", name: "devices", path: "/api/devices" },
  {
    route: "/api/devices/[id]",
    name: "device detail",
    path: "/api/devices/{device}",
  },
  {
    route: "/api/devices/[id]/bundles",
    name: "device bundles",
    path: "/api/devices/{device}/bundles",
  },
  {
    route: "/api/devices/[id]/tracked-apps",
    name: "device tracked apps",
    path: "/api/devices/{device}/tracked-apps",
  },
  {
    route: "/api/devices/for-app/[appId]",
    name: "devices for app",
    path: "/api/devices/for-app/{app}",
  },

  // -- per-app detail
  {
    route: "/api/apps/[id]/detail",
    name: "app detail (Instagram)",
    path: "/api/apps/{app}/detail",
  },
  {
    route: "/api/apps/[id]/since-install",
    name: "since-install (Instagram)",
    path: "/api/apps/{app}/since-install",
  },
  {
    route: "/api/apps/[id]/history-stats",
    name: "history-stats (Instagram)",
    path: "/api/apps/{app}/history-stats",
  },

  // -- profiles + preferences
  { route: "/api/focus", name: "focus", path: "/api/focus" },
  {
    route: "/api/privacy-profile",
    name: "privacy profile",
    path: "/api/privacy-profile",
  },
  {
    route: "/api/privacy-profile/mismatches",
    name: "privacy profile mismatches",
    path: "/api/privacy-profile/mismatches",
  },
  {
    route: "/api/accessibility-profile",
    name: "accessibility profile",
    path: "/api/accessibility-profile",
  },
  { route: "/api/preferences", name: "preferences", path: "/api/preferences" },
  { route: "/api/settings", name: "settings", path: "/api/settings" },
  {
    route: "/api/settings/desktop",
    name: "desktop settings",
    path: "/api/settings/desktop",
  },
  { route: "/api/date-format", name: "date format", path: "/api/date-format" },
  { route: "/api/locale", name: "locale", path: "/api/locale" },
  {
    route: "/api/feature-flags",
    name: "feature flags",
    path: "/api/feature-flags",
  },
  {
    route: "/api/notification-prefs",
    name: "notification prefs",
    path: "/api/notification-prefs",
  },
  {
    route: "/api/dashboard/layout",
    name: "dashboard layout",
    path: "/api/dashboard/layout",
  },
  {
    route: "/api/coachmark-state",
    name: "coachmark state",
    path: "/api/coachmark-state",
  },
  {
    route: "/api/dev-menu-state",
    name: "dev menu state",
    path: "/api/dev-menu-state",
  },

  // -- derived views + stats
  { route: "/api/stats", name: "stats", path: "/api/stats" },
  // KNOWN NONDETERMINISM IN THE APP, not in this harness. /api/stats/radar
  // selects a subset of apps and two runs of the SAME implementation can
  // return DIFFERENT app sets from an identical database — observed
  // swapping 95427241 for 94778184 between two freshly, identically
  // seeded servers. Sorting cannot reconcile differing sets, so the app
  // list is compared by size only while the axes and the rating legend —
  // which are stable — are compared in full.
  //
  // This is worth fixing in the route (add a deterministic tiebreak to
  // the selection) and then tightening this entry back to a full
  // comparison; until then the strongest honest contract is the shape.
  {
    route: "/api/stats/radar",
    name: "stats radar",
    path: "/api/stats/radar",
    canonicalizeById: true,
    transform: (json) => ({
      ...json,
      apps: { count: (json.apps ?? []).length },
    }),
  },
  {
    route: "/api/stats/timeline",
    name: "stats timeline",
    path: "/api/stats/timeline",
  },
  {
    route: "/api/stats/matrix",
    name: "stats matrix",
    path: "/api/stats/matrix",
  },
  {
    route: "/api/compare",
    name: "compare",
    path: "/api/compare?a=id:{app}&b=id:{app2}",
  },
  { route: "/api/triage", name: "triage", path: "/api/triage" },
  {
    route: "/api/review-queue",
    name: "review queue",
    path: "/api/review-queue",
  },
  {
    route: "/api/related-apps",
    name: "related apps",
    path: "/api/related-apps?sourceAppId={app}",
  },
  {
    route: "/api/age-rating/summary",
    name: "age-rating summary",
    path: "/api/age-rating/summary",
  },
  { route: "/api/shortlist", name: "shortlist", path: "/api/shortlist" },
  {
    route: "/api/shortlist/export",
    name: "shortlist export",
    path: "/api/shortlist/export",
  },
  {
    route: "/api/verdicts",
    name: "verdicts (Instagram)",
    path: "/api/verdicts?appId={app}",
  },
  {
    route: "/api/annotations",
    name: "annotations",
    path: "/api/annotations?appId={app}",
  },

  // -- history + changelog
  { route: "/api/changelog", name: "global changelog", path: "/api/changelog" },
  // Health-check rows are periodic background output (first tick 60 s
  // after boot) — their presence depends on uptime and their detail blob
  // is machine state. Compare user/seed activity only.
  {
    route: "/api/activity",
    name: "activity",
    path: "/api/activity",
    transform: (json) => ({
      ...json,
      // health_check is the 24 h ticker; migration_* rows are emitted at
      // boot by instrumentation.ts and their ordering between same-
      // millisecond steps is not stable across two processes. Neither is
      // user or seed activity, which is what this route owes the port.
      rows: (json.rows ?? []).filter(
        (r) =>
          r.type !== "health_check" && !String(r.type).startsWith("migration")
      ),
      total: undefined,
    }),
  },

  // -- job status (idle at parity time; the runners are not started)
  { route: "/api/sync/status", name: "sync status", path: "/api/sync/status" },
  {
    route: "/api/tasks/active",
    name: "active tasks",
    path: "/api/tasks/active",
  },
  {
    route: "/api/wayback/import-all",
    name: "wayback bulk status",
    path: "/api/wayback/import-all",
  },
  {
    route: "/api/policy/sync-all",
    name: "policy bulk status",
    path: "/api/policy/sync-all",
  },

  // -- imports
  { route: "/api/imports", name: "imports", path: "/api/imports" },
  // `lastRunAt` / `running` describe the import-queue worker's own
  // schedule, not request-driven state — a background tick that lands on
  // one server and not the other is a timing race, not a parity failure.
  {
    route: "/api/imports/queue",
    name: "import queue",
    path: "/api/imports/queue",
    transform: (json) => ({ ...json, lastRunAt: "~tick", running: "~tick" }),
  },
  {
    route: "/api/import/audit-bundle/recent",
    name: "recent audit-bundle imports",
    path: "/api/import/audit-bundle/recent",
  },

  // -- tasks + onboarding
  { route: "/api/user-tasks", name: "user tasks", path: "/api/user-tasks" },
  {
    route: "/api/notifications",
    name: "notifications",
    path: "/api/notifications",
  },

  // -- auth + liveness
  {
    route: "/api/auth/admin-token/status",
    name: "admin token status",
    path: "/api/auth/admin-token/status",
  },
  { route: "/api/health", name: "health (liveness)", path: "/api/health" },
  { route: "/api/ready", name: "ready (readiness)", path: "/api/ready" },

  // -- export
  { route: "/api/export", name: "export", path: "/api/export" },

  // -- AI (provider disabled by default, so this is the empty-log shape)
  {
    route: "/api/ai/debug-log",
    name: "AI debug log",
    path: "/api/ai/debug-log",
  },

  // -- CSP report ring. Empty on both sides at parity time; a populated
  //    ring is per-process machine state, so only the shape is pinned.
  {
    route: "/api/csp-report",
    name: "CSP report ring",
    path: "/api/csp-report",
  },

  // -- rate-limit counters. Both sides have served the identical request
  //    sequence by this point, so the counters must agree.
  {
    route: "/api/rate-limit/status",
    name: "rate-limit status",
    path: "/api/rate-limit/status",
  },
];

// ── READS with a volatility transform ───────────────────────────────
// Machine state (RSS, heap, disk free, WAL bytes, uptime, pid, port)
// differs between two processes by definition. Compare the stable
// envelope — keys present, statuses, booleans — not the measurements.

/** Recursively blank every value whose key looks like a measurement. */
const MEASURE_KEY =
  /(rss|heap|mem|bytes|size|free|used|total|uptime|pid|port|ms|duration|elapsed|walB|freelist|utilisation|utilization|count|generatedAt|timestamp|lastRun|startedAt|checkedAt|cpu|load|avg|wal|mb|host|external|severity)/i;

/** Blank EVERY numeric leaf. For routes that are wholly machine state
 * (the diagnostics family): the contract they owe the Rust core is the
 * shape and the key set, since no measurement can agree across two
 * processes. */
export const blankNumbers = (value) => {
  if (Array.isArray(value)) {
    return value.map(blankNumbers);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = blankNumbers(v);
    }
    return out;
  }
  return typeof value === "number" ? "~measured" : value;
};

/** Blank EVERY scalar leaf, keeping only the key structure. For routes
 * that are entirely per-process history — the runtime diagnostics carry
 * a recent-requests list, so two servers that received the same requests
 * a few milliseconds apart legitimately report different routes. What
 * the Rust core owes here is the response's shape. */
export const blankScalars = (value) => {
  // Collapse lists entirely: the recent-requests array's LENGTH is also
  // per-process (each server saw a slightly different request sequence),
  // so preserving it would diff on timing alone.
  if (Array.isArray(value)) {
    return "~list";
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = blankScalars(v);
    }
    return out;
  }
  return value === null ? null : "~runtime";
};

export const blankMeasurements = (value) => {
  if (Array.isArray(value)) {
    return value.map(blankMeasurements);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        MEASURE_KEY.test(k) && (typeof v === "number" || typeof v === "string")
          ? "~measured"
          : blankMeasurements(v);
    }
    return out;
  }
  return value;
};

export const VOLATILE_READS = [
  {
    route: "/api/diagnostics/database",
    name: "diagnostics: database",
    path: "/api/diagnostics/database",
    transform: blankNumbers,
  },
  {
    route: "/api/diagnostics/disk",
    name: "diagnostics: disk",
    path: "/api/diagnostics/disk",
    transform: blankNumbers,
  },
  {
    route: "/api/diagnostics/errors",
    name: "diagnostics: errors",
    path: "/api/diagnostics/errors",
    transform: blankMeasurements,
  },
  {
    route: "/api/diagnostics/health",
    name: "diagnostics: health",
    path: "/api/diagnostics/health",
    transform: (v) => blankNumbers(blankMeasurements(v)),
  },
  {
    route: "/api/diagnostics/runtime",
    name: "diagnostics: runtime",
    path: "/api/diagnostics/runtime",
    transform: blankScalars,
  },
  {
    route: "/api/deployment/diagnostics",
    name: "deployment diagnostics",
    path: "/api/deployment/diagnostics",
    transform: (v) => blankNumbers(blankMeasurements(v)),
  },
  {
    route: "/api/desktop/diagnostics",
    name: "desktop diagnostics",
    path: "/api/desktop/diagnostics",
    transform: blankScalars,
  },
  {
    route: "/api/backup/snapshots",
    name: "backup snapshots",
    path: "/api/backup/snapshots",
    transform: blankMeasurements,
  },
];

// ── MUTATIONS ────────────────────────────────────────────────────────
// Ordered. Each runs against both sides with an identical body, then
// `after` re-reads the affected collection so persistence is compared,
// not just the response envelope.

export const MUTATIONS = [
  // -- preferences round-trip
  {
    route: "/api/date-format",
    name: "set date format",
    method: "POST",
    path: "/api/date-format",
    body: { format: "iso" },
    after: "/api/date-format",
  },
  {
    route: "/api/locale",
    name: "set locale",
    method: "POST",
    path: "/api/locale",
    body: { locale: "en" },
    after: "/api/locale",
  },
  {
    route: "/api/preferences",
    name: "update preferences",
    method: "PUT",
    path: "/api/preferences",
    body: { theme: "dark" },
    after: "/api/preferences",
  },
  {
    route: "/api/settings",
    name: "update settings",
    method: "POST",
    path: "/api/settings",
    body: { app_store_region: "us" },
    after: "/api/settings",
  },
  {
    route: "/api/settings/desktop",
    name: "update desktop settings",
    method: "POST",
    path: "/api/settings/desktop",
    body: { desktop_hide_dock: false },
    after: "/api/settings/desktop",
  },
  {
    route: "/api/notification-prefs",
    name: "update notification prefs",
    method: "PUT",
    path: "/api/notification-prefs",
    body: { prefs: { bell: true } },
    after: "/api/notification-prefs",
  },

  // -- focus + profiles (re-assert the seeded values; idempotent)
  {
    route: "/api/focus",
    name: "set focus",
    method: "POST",
    path: "/api/focus",
    body: {
      audience: "self",
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: true,
    },
    after: "/api/focus",
  },
  {
    route: "/api/accessibility-profile",
    name: "set accessibility profile",
    method: "PUT",
    path: "/api/accessibility-profile",
    body: {
      profile: {
        voiceover: "required",
        voice_control: "required",
        captions: "nice",
      },
    },
    after: "/api/accessibility-profile",
  },

  // -- feature-flag overrides (set, then clear both ways)
  {
    route: "/api/feature-flags/overrides",
    name: "set flag override",
    method: "POST",
    path: "/api/feature-flags/overrides",
    body: { key: "flag.about.ai_disclosure", value: "off" },
    after: "/api/feature-flags",
  },
  {
    route: "/api/feature-flags/overrides/[key]",
    name: "clear one flag override",
    method: "DELETE",
    path: "/api/feature-flags/overrides/flag.about.ai_disclosure",
    after: "/api/feature-flags",
  },

  // -- dashboard layout
  {
    route: "/api/dashboard/layout/preset",
    name: "apply layout preset",
    method: "POST",
    path: "/api/dashboard/layout/preset",
    body: { preset: "minimal" },
    after: "/api/dashboard/layout",
  },
  {
    route: "/api/dashboard/layout",
    name: "reset dashboard layout",
    method: "DELETE",
    path: "/api/dashboard/layout",
    after: "/api/dashboard/layout",
  },

  // -- shortlist + verdicts + annotations (the user-authored tables)
  {
    route: "/api/shortlist",
    name: "add to shortlist",
    method: "POST",
    path: "/api/shortlist",
    body: {
      sourceAppId: "{app}",
      candidateAppleId: "{app2}",
      candidateName: "Parity Candidate",
      candidateStoreUrl: "https://apps.apple.com/us/app/id{app2}",
    },
    after: "/api/shortlist",
  },
  {
    route: "/api/verdicts",
    name: "set verdict",
    method: "POST",
    path: "/api/verdicts",
    body: { appId: "{app}", verdict: "safe" },
    after: "/api/verdicts?appId={app}",
  },
  {
    route: "/api/verdicts/bulk",
    name: "bulk verdicts",
    method: "POST",
    path: "/api/verdicts/bulk",
    body: { appIds: ["{app}"], verdict: "safe" },
    after: "/api/verdicts?appId={app}",
  },
  {
    route: "/api/annotations",
    name: "create annotation",
    method: "POST",
    path: "/api/annotations",
    body: { appId: "{app}", content: "parity note", visibility: "export" },
    after: "/api/annotations",
  },
  {
    route: "/api/annotations/[id]",
    name: "update annotation",
    method: "PATCH",
    path: "/api/annotations/{annotation}",
    body: { content: "parity note (edited)" },
    after: "/api/annotations",
  },

  // -- acknowledge + undo (changeCount side effects)
  {
    route: "/api/apps/[id]/acknowledge",
    name: "acknowledge changes",
    method: "POST",
    path: "/api/apps/{app}/acknowledge",
    body: {},
    capture: { "{actionId}": "record.id" },
    after: "/api/apps",
  },
  {
    route: "/api/apps/[id]/acknowledge/undo",
    name: "undo acknowledge",
    method: "POST",
    path: "/api/apps/{app}/acknowledge/undo",
    body: {
      actionId: "{actionId}",
      // The client stashes the pre-acknowledge counters and posts them
      // back; the route rejects anything non-finite or negative.
      preState: {
        changeCount: 0,
        changesAcknowledgedAt: 0,
        changesSnoozedUntil: 0,
      },
    },
    after: "/api/apps",
  },

  // -- onboarding / task state
  {
    route: "/api/welcomed-at",
    name: "set welcomed-at",
    method: "POST",
    path: "/api/welcomed-at",
    after: "/api/user-tasks",
  },
  {
    route: "/api/user-tasks/visit",
    name: "record task visit",
    method: "POST",
    path: "/api/user-tasks/visit",
    body: { surface: "app_detail" },
    after: "/api/user-tasks",
  },
  {
    route: "/api/coachmark-state",
    name: "update coachmark state",
    method: "POST",
    path: "/api/coachmark-state",
    body: { completed: true },
    after: "/api/coachmark-state",
  },
  {
    route: "/api/dev-menu-state",
    name: "update dev-menu state",
    method: "POST",
    path: "/api/dev-menu-state",
    body: { enabled: false },
    after: "/api/dev-menu-state",
  },
  {
    route: "/api/migration-flow/consume",
    name: "consume migration flow",
    method: "POST",
    path: "/api/migration-flow/consume",
    after: "/api/settings",
  },
  {
    route: "/api/activity/queue-session",
    name: "queue activity session",
    method: "POST",
    path: "/api/activity/queue-session",
    body: {},
    after: "/api/activity",
  },

  // -- notifications
  {
    route: "/api/notifications",
    name: "mark notifications read",
    method: "POST",
    path: "/api/notifications",
    body: { action: "mark_read" },
    after: "/api/notifications",
  },
  {
    route: "/api/dev/seed-notification",
    name: "seed a notification",
    method: "POST",
    path: "/api/dev/seed-notification",
    body: {
      appId: "{app}",
      appName: "Instagram",
      changes: [
        {
          category: "privacy-label",
          type: "added",
          description: "parity fixture change",
        },
      ],
    },
    after: "/api/notifications",
  },

  // -- CSP report ingest (public POST into the in-memory ring)
  {
    route: "/api/csp-report",
    name: "post a CSP report",
    method: "POST",
    path: "/api/csp-report",
    body: {
      "csp-report": {
        "violated-directive": "script-src",
        "blocked-uri": "inline",
      },
    },
    after: "/api/csp-report",
  },

  // -- diagnostics that mutate (manual run / clear)
  {
    route: "/api/diagnostics/health",
    name: "run health check on demand",
    method: "POST",
    path: "/api/diagnostics/health",
    compareStatusOnly: true,
  },
  {
    route: "/api/diagnostics/database",
    name: "database diagnostics action",
    method: "POST",
    path: "/api/diagnostics/database",
    body: { runIntegrityCheck: true },
    compareStatusOnly: true,
  },
  {
    route: "/api/diagnostics/runtime",
    name: "clear runtime diagnostics",
    method: "DELETE",
    path: "/api/diagnostics/runtime",
    compareStatusOnly: true,
  },
  {
    route: "/api/diagnostics/errors",
    name: "clear error ring",
    method: "DELETE",
    path: "/api/diagnostics/errors",
    after: "/api/diagnostics/errors",
  },
  {
    route: "/api/rate-limit/status",
    name: "clear rate-limit counters",
    method: "DELETE",
    path: "/api/rate-limit/status",
    body: { category: "all" },
    after: "/api/rate-limit/status",
  },
  {
    route: "/api/ai/debug-log",
    name: "clear AI debug log",
    method: "DELETE",
    path: "/api/ai/debug-log",
    after: "/api/ai/debug-log",
  },

  // -- imports lifecycle. Every item-level route needs an importId, so
  //    the group opens by creating one and `{import}` resolves to it.
  {
    route: "/api/imports",
    name: "create an import",
    method: "POST",
    path: "/api/imports",
    body: { source: "manual" },
    after: "/api/imports",
  },
  {
    route: "/api/imports/items",
    name: "add import items",
    method: "POST",
    path: "/api/imports/items",
    body: {
      importId: "{import}",
      items: [{ query: "Parity Test App", status: "unmatched" }],
    },
    capture: { "{importItem}": "items.0.id" },
    after: "/api/imports",
  },
  {
    route: "/api/imports/items/update",
    name: "update an import item",
    method: "POST",
    path: "/api/imports/items/update",
    body: { itemId: "{importItem}", status: "skipped" },
    compareStatusOnly: true,
  },
  {
    route: "/api/imports/queue",
    name: "enqueue an import",
    method: "POST",
    path: "/api/imports/queue",
    body: { names: ["Parity Test App"] },
    after: "/api/imports/queue",
  },
  {
    route: "/api/imports/complete",
    name: "complete an import",
    method: "POST",
    path: "/api/imports/complete",
    body: { importId: "{import}" },
    compareStatusOnly: true,
  },
  {
    route: "/api/imports",
    name: "delete the import",
    method: "DELETE",
    path: "/api/imports?id={import}",
    body: {},
    after: "/api/imports",
  },

  // -- manual apps (fully local; no scraping)
  {
    route: "/api/manual-apps",
    name: "create manual app",
    method: "POST",
    path: "/api/manual-apps",
    body: {
      name: "Parity Manual App",
      developer: "Parity",
      source: "sideloaded",
    },
    after: "/api/manual-apps",
  },
  {
    route: "/api/manual-apps/bulk",
    name: "bulk manual apps",
    method: "POST",
    path: "/api/manual-apps/bulk",
    body: {
      apps: [
        { name: "Parity Bulk App", developer: "Parity", source: "sideloaded" },
      ],
    },
    after: "/api/manual-apps",
  },
  {
    route: "/api/manual-apps/[id]",
    name: "update manual app",
    method: "PUT",
    path: "/api/manual-apps/{manualApp}",
    body: { name: "Parity Manual App (edited)" },
    after: "/api/manual-apps",
  },

  // -- devices
  {
    route: "/api/devices",
    name: "create device",
    method: "POST",
    path: "/api/devices",
    body: { name: "Parity Device", model: "iPhone" },
    after: "/api/devices",
  },
  {
    route: "/api/devices/[id]",
    name: "update device",
    method: "PATCH",
    path: "/api/devices/{device}",
    body: { name: "Parity Device (edited)" },
    after: "/api/devices",
  },

  // -- backup (local file round-trip, no network)
  {
    route: "/api/backup/snapshots",
    name: "create backup snapshot",
    method: "POST",
    path: "/api/backup/snapshots",
    compareStatusOnly: true,
  },

  // -- auth round-trip (token login/logout)
  {
    route: "/api/auth/admin-token/login",
    name: "admin token login",
    method: "POST",
    path: "/api/auth/admin-token/login",
    body: { token: "{token}" },
    compareStatusOnly: true,
  },
  {
    route: "/api/auth/admin-token/logout",
    name: "admin token logout",
    method: "POST",
    path: "/api/auth/admin-token/logout",
    after: "/api/auth/admin-token/status",
  },

  // -- dev-only helpers that are deterministic and local
  {
    route: "/api/dev/reset-changelog",
    name: "reset changelog",
    method: "POST",
    path: "/api/dev/reset-changelog",
    after: "/api/changelog",
  },
  {
    route: "/api/dev/sync-stop",
    name: "stop sync",
    method: "POST",
    path: "/api/dev/sync-stop",
    after: "/api/sync/status",
  },

  // -- deletions of user-authored rows (run late; they undo the above)
  {
    route: "/api/annotations/[id]",
    name: "delete annotation",
    method: "DELETE",
    path: "/api/annotations/{annotation}",
    after: "/api/annotations",
  },
  {
    route: "/api/shortlist",
    name: "remove from shortlist",
    method: "DELETE",
    path: "/api/shortlist?all=1",
    body: {},
    after: "/api/shortlist",
  },
  {
    route: "/api/verdicts",
    name: "clear verdict",
    method: "DELETE",
    path: "/api/verdicts?appId={app}",
    body: {},
    after: "/api/verdicts?appId={app}",
  },
  {
    route: "/api/manual-apps/[id]",
    name: "delete manual app",
    method: "DELETE",
    path: "/api/manual-apps/{manualApp}",
    after: "/api/manual-apps",
  },
  {
    route: "/api/devices/[id]",
    name: "delete device",
    method: "DELETE",
    path: "/api/devices/{device}",
    after: "/api/devices",
  },
  {
    route: "/api/feature-flags/overrides",
    name: "clear all flag overrides",
    method: "DELETE",
    path: "/api/feature-flags/overrides",
    after: "/api/feature-flags",
  },
];

// ── TEARDOWN ─────────────────────────────────────────────────────────
// Destructive. Ordered last because each invalidates everything before.

export const TEARDOWN = [
  {
    route: "/api/dev/wipe-apps",
    name: "wipe apps",
    method: "POST",
    path: "/api/dev/wipe-apps",
    after: "/api/apps",
  },
  {
    route: "/api/apps",
    name: "delete one app",
    method: "DELETE",
    path: "/api/apps?id={app}",
    body: {},
    after: "/api/apps",
  },
  {
    route: "/api/admin/start-over",
    name: "start over",
    method: "POST",
    path: "/api/admin/start-over",
    body: {},
    // Deliberately rate-limited upstream. Two sides agreeing on a 429 is
    // still parity — what would NOT be is one throttling and one not.
    allowErrorStatus: true,
    after: "/api/apps",
  },
  {
    route: "/api/reset",
    name: "reset",
    method: "POST",
    path: "/api/reset",
    after: "/api/apps",
  },
];

// ── QUARANTINE ───────────────────────────────────────────────────────
// Status-compared only. Every entry states why the body cannot be.

export const QUARANTINE = [
  // -- outbound to Apple / iTunes. A parity run must not depend on a
  //    third party's availability or on what Apple served that minute.
  {
    route: "/api/search",
    method: "POST",
    why: "hits the iTunes Search API; results change with Apple's index",
  },
  {
    route: "/api/scrape",
    method: "POST",
    why: "downloads and parses live App Store HTML",
  },
  {
    route: "/api/sync/trigger",
    method: "POST",
    why: "re-scrapes every tracked app against Apple; also long-running",
  },
  {
    route: "/api/manual-apps/[id]/scrape",
    method: "POST",
    why: "fetches the manual app's live policy URL",
  },
  {
    route: "/api/dev/seed-sample-data",
    method: "POST",
    why: "already run identically by the seeder; ?source=live would scrape",
  },

  // -- outbound to archive.org
  {
    route: "/api/apps/[id]/import-history",
    method: "POST",
    why: "queries archive.org and can submit Save Page Now",
  },
  {
    route: "/api/wayback/import-all",
    method: "POST",
    why: "bulk archive.org crawl; long-running and rate-limited upstream",
  },

  // -- outbound to an AI provider
  {
    route: "/api/ai/test",
    method: "POST",
    why: "opens a connection to the configured AI provider",
  },
  {
    route: "/api/ai/models",
    method: "POST",
    why: "lists models from the configured AI provider",
  },
  {
    route: "/api/ai/policy-sample",
    method: "POST",
    why: "runs a live completion against the AI provider",
  },
  {
    route: "/api/policy/regenerate",
    method: "POST",
    why: "re-fetches policy text and calls the AI provider",
  },
  {
    route: "/api/policy/sync-all",
    method: "POST",
    why: "bulk policy fetch across every app; long-running",
  },

  // -- outbound to an arbitrary user-supplied endpoint
  {
    route: "/api/notifications/webhook-test",
    method: "POST",
    why: "POSTs to a user-configured webhook URL — must never fire in CI",
  },
  {
    route: "/api/update-status",
    method: "GET",
    why: "queries the GitHub releases feed for the updater",
  },

  // -- host / device dependent: cfgutil, USB, Apple Configurator
  {
    route: "/api/device-actions/backup",
    method: "POST",
    why: "drives cfgutil against physically attached hardware",
  },
  {
    route: "/api/device-actions/uninstall",
    method: "GET,POST",
    why: "drives cfgutil against physically attached hardware",
  },
  {
    route: "/api/device-sync/preview",
    method: "POST",
    why: "reads a connected device's installed-app list",
  },
  {
    route: "/api/device-sync/commit",
    method: "POST",
    why: "writes device state read from attached hardware",
  },

  // -- large binary / streaming payloads. Not JSON, and sized by host
  //    state; the e2e suite covers that they download at all.
  {
    route: "/api/backup/export",
    method: "GET",
    why: "streams a binary SQLite backup sized by host state",
  },
  {
    route: "/api/backup/snapshots/[filename]",
    method: "GET",
    why: "streams a snapshot file whose name is generated per run",
  },
  {
    route: "/api/backup/restore",
    method: "POST",
    why: "replaces the live database — would destroy the parity fixture mid-run",
  },
  {
    route: "/api/import/audit-bundle",
    method: "POST",
    why: "needs a multipart bundle upload; covered by the e2e suite",
  },
  {
    route: "/api/diagnostics/bundle",
    method: "GET",
    why: "zip of machine state (logs, RSS, disk) — nothing stable to compare",
  },
  {
    route: "/api/deployment/support-bundle",
    method: "GET",
    why: "zip of machine state — nothing stable to compare",
  },

  // -- per-id reads with no canned fixture rows
  {
    route: "/api/manual-apps/[id]/policy-version/[versionId]",
    method: "GET",
    why: "the canned fixture creates no manual-app policy versions to address",
  },
  {
    route: "/api/policy/status/[appId]",
    method: "GET",
    why: "policy pipeline is disabled by default; no analysis rows exist",
  },
  {
    route: "/api/policy/version/[id]",
    method: "GET",
    why: "no policy versions exist without the AI pipeline having run",
  },
  {
    route: "/api/policy/version/[id]/diff",
    method: "GET",
    why: "no policy versions exist without the AI pipeline having run",
  },
  {
    route: "/api/imports/items/retry",
    method: "POST",
    why: "retry re-enters the scrape path against Apple",
  },
  {
    route: "/api/imports/items/change-match",
    method: "POST",
    why: "re-scrapes the supplied App Store URL — returns 502 with no network",
  },
  {
    route: "/api/manual-apps/[id]/restore",
    method: "POST",
    why: "needs a soft-deleted manual app; the delete runs later in the order",
  },
  {
    route: "/api/preview",
    method: "GET",
    why: "requires ?url= and fetches that third-party page",
  },
  {
    route: "/api/favicon",
    method: "GET",
    why: "requires ?host= and fetches that host's favicon",
  },
  {
    route: "/api/backup/preview",
    method: "POST",
    why: "requires an uploaded backup payload; covered by the e2e suite",
  },
  {
    route: "/api/export/audit-bundle",
    method: "POST",
    why: "403 under the seeded focus — the export is a focus-gated surface",
  },
];
