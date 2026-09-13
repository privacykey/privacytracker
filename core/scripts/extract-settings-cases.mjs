#!/usr/bin/env node
/**
 * Generate the Rust settings-read port's rule tables AND its differential
 * fixture by importing and RUNNING the real Node code.
 *
 * Two outputs, one script, so they can never drift from each other:
 *
 *   core/src/server/flag_rules.json      — the feature-flag rule tables
 *     (HARD_DEFAULTS, AUDIENCE_RULES, GOAL_RULES, ACCESSIBILITY_RULES,
 *     FLAG_DEPENDENCIES, WIRED_FLAGS), lifted from `lib/feature-flag-rules.ts`
 *     and `lib/feature-flag-wired.ts`. The Rust server `include_str!`s this
 *     at build time; it is DATA the resolver runs over, not a test.
 *
 *   core/tests/fixtures/settings-cases.json — expected outputs for the three
 *     pure functions behind the settings reads, produced by calling them:
 *       - `maskWebhookUrl` (module-local in app/api/settings/route.ts — its
 *         source text is lifted and executed, never transcribed),
 *       - `reconcileLayout` + `matchDashboardPreset` (lib/dashboard-layout.ts),
 *         plus the five DASHBOARD_PRESETS the port must rebuild,
 *       - the flag resolver (`resolveFlag` / `resolveFocusBaseline` from
 *         lib/feature-flags.ts) over a table of resolver contexts, each
 *         recorded as the full sorted row list the route would serve — or,
 *         to keep the file small, as the rows that DIFFER from a reference
 *         context, since the sort order is value-independent.
 *
 * Why this exists: the read-parity differ compares these routes on ONE
 * database state. It cannot see that `computeFlag` applies goal rules in a
 * fixed order, that an override beats a dependency collapse, that the kill
 * switch ignores its own override, that `reconcileLayout` UNSHIFTs an
 * orphaned first card, or that `maskWebhookUrl` lowercases the host but not
 * the path. Each of those is a plausible wrong port that one database state
 * cannot distinguish from the right one.
 *
 * The outputs are checked in so reviewers can diff them, and CI re-runs this
 * script and fails on any change (see `just parity-settings-cases`) — so a
 * rule-table edit or a resolver change that nobody ported is caught at the
 * fixture, not in production.
 *
 * Usage:  node --import tsx core/scripts/extract-settings-cases.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

// None of the modules imported below open the database, but the guard
// costs nothing and protects the next person who adds an import that does.
process.env.PRIVACYTRACKER_DATA_DIR ??= mkdtempSync(
  path.join(tmpdir(), "pt-settings-cases-")
);

const rules = await import(path.join(repo, "lib", "feature-flag-rules.ts"));
const { resolveFlag, resolveFocusBaseline } = await import(
  path.join(repo, "lib", "feature-flags.ts")
);
const { WIRED_FLAGS } = await import(
  path.join(repo, "lib", "feature-flag-wired.ts")
);
const layout = await import(path.join(repo, "lib", "dashboard-layout.ts"));

// ── maskWebhookUrl: lift the real source text and execute it ────────────
//
// The function is module-local to the route file, which also imports
// next/server and the database. Rather than transcribe it (the thing this
// whole script exists to avoid), cut the three declarations out of the
// file, write them to a scratch .ts module with an export, and import that.
// The regexes are anchored on the declaration lines; a rename or a move
// makes this throw rather than silently pin an empty function.
function liftMaskWebhookUrl() {
  const src = readFileSync(
    path.join(repo, "app", "api", "settings", "route.ts"),
    "utf8"
  );
  const pick = (re, what) => {
    const m = src.match(re);
    if (!m) {
      throw new Error(`extract-settings-cases: could not find ${what}`);
    }
    return m[0];
  };
  const text = [
    pick(/^const WEBHOOK_MASK = [^\n]+\n/m, "WEBHOOK_MASK"),
    pick(
      /^function maskWebhookPathSegment\([\s\S]*?\n}\n/m,
      "maskWebhookPathSegment"
    ),
    pick(/^function maskWebhookUrl\([\s\S]*?\n}\n/m, "maskWebhookUrl"),
    "export { maskWebhookUrl };\n",
  ].join("\n");
  const dir = mkdtempSync(path.join(tmpdir(), "pt-mask-webhook-"));
  const file = path.join(dir, "mask-webhook-url.ts");
  writeFileSync(file, text);
  return file;
}
const { maskWebhookUrl } = await import(pathToFileURL(liftMaskWebhookUrl()));

// ── 1. the rule tables ──────────────────────────────────────────────────

const flagRules = {
  generated_by: "core/scripts/extract-settings-cases.mjs",
  source: "lib/feature-flag-rules.ts + lib/feature-flag-wired.ts",
  note: "DO NOT EDIT BY HAND. Regenerate with `just parity-settings-cases`. Key order inside every table is the Node object's own key order.",
  hard_defaults: rules.HARD_DEFAULTS,
  audience_rules: rules.AUDIENCE_RULES,
  goal_rules: rules.GOAL_RULES,
  accessibility_rules: rules.ACCESSIBILITY_RULES,
  dependencies: rules.FLAG_DEPENDENCIES,
  wired: [...WIRED_FLAGS],
};

// ── 2. maskWebhookUrl ───────────────────────────────────────────────────
//
// Each input names the behaviour it pins. The stored value is normally the
// WHATWG serialisation `validateExternalUrl` produced on write — lowercase
// host, default port dropped, dot segments resolved — so the first block is
// the realistic input and the rest is what a hand-edited row could hold.
const WEBHOOK_INPUTS = [
  // realistic, already-canonical stored values
  "",
  "   ",
  "https://hooks.slack.com/services/T0PARITY/B0FIXTURE/s3cretT0ken",
  "https://hooks.slack.com/services/T/B/x/y/z",
  "https://hooks.slack.com/services/T0AAAA/B0BBBB",
  "https://hooks.slack.com/other/a/b/c",
  "https://discord.com/api/webhooks/123456/token-abc",
  "https://outlook.office.com/webhook/guid@guid/IncomingWebhook/id/guid",
  "https://example.com",
  "https://example.com/",
  "https://example.com/hook",
  "https://example.com/hook/",
  "https://example.com:8443/hook",
  "http://example.com:8080/hook",
  "https://example.com/a/b/c/d/e/f",
  "https://example.com/9abc/x",
  "https://example.com/a-very-long-first-segment-over-25-chars/x",
  "https://example.com/Ab_c.d-e/x",
  "https://example.com/a%20b/x",
  "https://example.com/hooks.slack.com/services/a/b/c",
  "https://hooks.slack.com/services//B/C/D",
  "https://hooks.slack.com/services/%20T/B/C",
  "https://[::1]:8080/hook",
  "https://127.0.0.1/hook",
  "wss://example.com/socket",
  // what a hand-edited row could hold
  " https://example.com/hook ",
  "https://example.com/hook\t\n",
  "https://example.com:443/hook",
  "http://example.com:80/hook",
  "https://example.com:0443/hook",
  "https://user:pass@example.com/hook",
  "https://example.com/hook?token=abc#frag",
  "https://hooks.slack.com/services/T/B/C?x=1#y",
  "https://hooks.slack.com:443/services/T/B/C",
  "https://HOOKS.SLACK.COM/services/T1/B2/s3",
  "HTTPS://Example.COM/Hook",
  "https://example.com//double//slash",
  "https://example.com/./a/../b/c",
  "https://example.com/a/%2e%2E/b",
  "https://example.com\\a\\b",
  "https://example.com/a b/x",
  "https://example.com/hooks/ T/x",
  "https:example.com/hook",
  "https:/example.com/hook",
  "https:////example.com/hook",
  "ftp://example.com/a/b",
  "file:///tmp/hook",
  "mailto:someone@example.com",
  "foo://bar/baz",
  "foo:bar/baz",
  "javascript:alert(1)",
  "data:text/plain,hi",
  "blob:https://example.com/uuid",
  // what `new URL` refuses
  "not a url",
  "example.com/hook",
  "https://",
  "https://exa mple.com/x",
  "https://example.com:99999/hook",
  "https://example.com:abc/hook",
  "http://[::1",
  "//example.com/hook",
  "/hook",
  "1https://example.com",
];

const webhookMasks = WEBHOOK_INPUTS.map((input) => ({
  input,
  expected: maskWebhookUrl(input),
}));

// ── 3. dashboard layout ─────────────────────────────────────────────────

const {
  CANONICAL_ORDER,
  DASHBOARD_PRESETS,
  DASHBOARD_PRESET_KEYS,
  FIRST_CLASS_CARDS,
  CALLOUT_CARDS,
  reconcileLayout,
  matchDashboardPreset,
} = layout;

const LAYOUT_CASES = [
  { name: "empty object", why: "no order, no hidden → canonical", stored: {} },
  {
    name: "empty array",
    why: "typeof [] is 'object' and it is truthy, so it is NOT the early-return default; it reaches the reconcile loop with no order",
    stored: [],
  },
  { name: "null", why: "falsy → default", stored: null },
  { name: "string", why: "typeof 'string' → default", stored: "nope" },
  { name: "number", why: "typeof 'number' → default", stored: 5 },
  { name: "true", why: "typeof 'boolean' → default", stored: true },
  {
    name: "non-array order and hidden",
    why: "Array.isArray gates both; a string is treated as absent",
    stored: { v: 1, order: "nope", hidden: "nope" },
  },
  ...DASHBOARD_PRESET_KEYS.map((key) => ({
    name: `preset ${key} stored verbatim`,
    why: "must round-trip to its own name",
    stored: DASHBOARD_PRESETS[key],
  })),
  {
    name: "minimal preset with hidden reversed",
    why: "hidden is order-insensitive: normaliseLayout sorts it canonically before comparing",
    stored: {
      v: 1,
      order: DASHBOARD_PRESETS.minimal.order,
      hidden: [...DASHBOARD_PRESETS.minimal.hidden].reverse(),
    },
  },
  {
    name: "minimal preset with one more hidden card",
    why: "a single extra hidden first-class card breaks the match",
    stored: {
      v: 1,
      order: DASHBOARD_PRESETS.minimal.order,
      hidden: [...DASHBOARD_PRESETS.minimal.hidden, "review_cta"],
    },
  },
  {
    name: "the read-parity fixture blob",
    why: "unknown ids, a non-string, a duplicate, a callout in hidden and an unknown in hidden — all in one row",
    stored: {
      v: 1,
      order: [
        "hero",
        "bogus_card",
        "review_cta",
        "hero",
        42,
        "activity_section",
      ],
      hidden: [
        "activity_section",
        "cleanup_callout",
        "hero",
        "hero",
        "not_a_card",
      ],
    },
  },
  {
    name: "order holds only hero",
    why: "task_list has no preceding canonical neighbour, so it is UNSHIFTed to the front, and every later card chains after it — hero ends up second, not first",
    stored: { order: ["hero"] },
  },
  {
    name: "order holds only the last canonical card",
    why: "everything slots in before it via the neighbour chain",
    stored: { order: ["manual_apps_banner"] },
  },
  {
    name: "order reversed",
    why: "known ids keep the user's order; nothing is missing so nothing is slotted",
    stored: {
      v: 1,
      order: [...CANONICAL_ORDER].reverse(),
      hidden: ["risk_tier_legend", "task_list"],
    },
  },
  {
    name: "canonical minus the first card",
    why: "the missing card is the one with no preceding neighbour → unshift",
    stored: { order: CANONICAL_ORDER.filter((id) => id !== "task_list") },
  },
  {
    name: "canonical minus hero, hero hidden",
    why: "a hidden card that is also missing from order is slotted back in AND stays hidden",
    stored: {
      order: CANONICAL_ORDER.filter((id) => id !== "hero"),
      hidden: ["hero"],
    },
  },
  {
    name: "two cards, callouts in hidden",
    why: "callouts are dropped from hidden entirely — it comes back empty",
    stored: {
      order: ["activity_section", "risk_section"],
      hidden: ["cleanup_callout", "manual_apps_banner"],
    },
  },
  {
    name: "wrong version and an extra key",
    why: "v is forced to 1 and unknown keys vanish",
    stored: { v: 2, order: [], hidden: [], extra: 1 },
  },
  {
    name: "non-string junk in both arrays",
    why: "typeof id === 'string' filters before the set lookup",
    stored: { order: [1, null, "hero", {}, "hero"], hidden: [null, "hero", 1] },
  },
  {
    name: "watchdog order truncated to five",
    why: "the rest is slotted by neighbour; whether that still matches the preset is for Node to say",
    stored: {
      order: DASHBOARD_PRESETS.watchdog.order.slice(0, 5),
      hidden: DASHBOARD_PRESETS.watchdog.hidden,
    },
  },
  {
    name: "hidden duplicated and unsorted",
    why: "dedupe then canonical sort",
    stored: {
      order: CANONICAL_ORDER,
      hidden: ["stale_section", "task_list", "stale_section", "hero"],
    },
  },
];

const layouts = LAYOUT_CASES.map((c) => {
  const reconciled = reconcileLayout(c.stored);
  return {
    name: c.name,
    why: c.why,
    stored: c.stored,
    expected: {
      layout: reconciled,
      matchedPreset: matchDashboardPreset(reconciled),
    },
  };
});

const layoutTables = {
  canonical_order: CANONICAL_ORDER,
  first_class_cards: [...FIRST_CLASS_CARDS],
  callout_cards: [...CALLOUT_CARDS],
  preset_keys: DASHBOARD_PRESET_KEYS,
  presets: DASHBOARD_PRESETS,
};

// ── 4. the flag resolver ────────────────────────────────────────────────
//
// Mirrors app/api/feature-flags/route.ts: build one row per HARD_DEFAULTS
// key, then sort by surface then key with localeCompare. `surfaceOf` is
// module-local there and three lines long; it is repeated here rather than
// lifted because the lift machinery above is for a function with real
// branching, and this one has none.
function surfaceOf(key) {
  const parts = key.split(".");
  return parts.length >= 2 ? parts[1] : "misc";
}

const KILL_SWITCH = "flag.devopts.feature_flag_system.enabled";

/** `getResolverContextFromDb`, minus the database. */
function contextOf({ audience, goals, runtime, overrides }) {
  const overrideMap = new Map();
  for (const [key, value] of overrides ?? []) {
    // getAllOverrides: only keys the registry knows. (`in`, not
    // hasOwnProperty — but no Object.prototype name can reach a row.)
    if (key in rules.HARD_DEFAULTS) {
      overrideMap.set(key, value);
    }
  }
  const focus = {
    audience,
    goals: rules.activeGoalsFrom({
      monitor: !!goals.monitor,
      cleanup: !!goals.cleanup,
      minimal: !!goals.minimal,
      accessibility: !!goals.accessibility,
    }),
    aiConfigured: false,
  };
  const killSwitchOff =
    (overrideMap.get(KILL_SWITCH) ?? rules.HARD_DEFAULTS[KILL_SWITCH]) ===
    "off";
  return {
    focus,
    overrides: overrideMap,
    killSwitchOff,
    runtimeEnvironment: runtime === "desktop" ? "desktop" : undefined,
  };
}

/** The route's GET body, exactly. */
function buildRows(ctx) {
  const rows = Object.keys(rules.HARD_DEFAULTS).map((key) => ({
    key,
    surface: surfaceOf(key),
    hardDefault: rules.HARD_DEFAULTS[key],
    currentValue: resolveFlag(key, ctx),
    focusValue: resolveFocusBaseline(key, ctx),
    override: ctx.overrides.get(key) ?? null,
    wired: WIRED_FLAGS.has(key),
  }));
  rows.sort((a, b) =>
    a.surface === b.surface
      ? a.key.localeCompare(b.key)
      : a.surface.localeCompare(b.surface)
  );
  return rows;
}

// A dependency chain of length two, if the table has one, so the recursion
// is pinned two levels deep rather than one.
const deps = rules.FLAG_DEPENDENCIES;
const grandchild = Object.keys(deps).find((k) => deps[deps[k]] !== undefined);
const PARENT = "flag.detail.timeline.wayback_rows";
const CHILD = "flag.detail.timeline.wayback_import";
if (deps[CHILD] !== PARENT) {
  throw new Error(
    `extract-settings-cases: expected ${CHILD} to depend on ${PARENT}; the override cases below assume it`
  );
}

const GOAL_SETS = [
  { name: "no goals", goals: {} },
  { name: "monitor", goals: { monitor: true } },
  { name: "cleanup", goals: { cleanup: true } },
  { name: "monitor+cleanup", goals: { monitor: true, cleanup: true } },
  { name: "minimal", goals: { minimal: true } },
  {
    name: "minimal with monitor+cleanup stored",
    goals: { minimal: true, monitor: true, cleanup: true },
  },
  { name: "accessibility", goals: { accessibility: true } },
  {
    name: "monitor+accessibility",
    goals: { monitor: true, accessibility: true },
  },
  {
    name: "minimal+accessibility",
    goals: { minimal: true, accessibility: true },
  },
];

const CONTEXTS = [];
for (const audience of ["self", "loved_one", "guardian"]) {
  for (const g of GOAL_SETS) {
    // The suppression of stored monitor/cleanup under minimal is a property
    // of activeGoalsFrom, not of the audience; once is enough.
    if (g.goals.minimal && g.goals.monitor && audience !== "self") {
      continue;
    }
    CONTEXTS.push({
      name: `${audience} / ${g.name}`,
      why: "the focus chain with no overrides and no runtime override",
      audience,
      goals: g.goals,
    });
  }
  CONTEXTS.push({
    name: `${audience} / monitor / desktop runtime`,
    why: "step 5 forces two desktop-only flags on regardless of audience",
    audience,
    goals: { monitor: true },
    runtime: "desktop",
  });
}
CONTEXTS.push(
  {
    name: "override: parent off",
    why: "step 6 — every dependent of an off parent collapses to off, with override null on the dependents",
    audience: "self",
    goals: { monitor: true },
    overrides: [[PARENT, "off"]],
  },
  {
    name: "override: parent off, child on",
    why: "step 7 — the child's own override beats the dependency collapse; its focusValue (override stripped) stays off",
    audience: "self",
    goals: { monitor: true },
    overrides: [
      [PARENT, "off"],
      [CHILD, "on"],
    ],
  },
  {
    name: "override: kill switch off with other overrides",
    why: "every flag is its hard default — INCLUDING the kill switch's own row, whose currentValue ignores its override, and including the overridden ones",
    audience: "guardian",
    goals: { monitor: true, accessibility: true },
    overrides: [
      [KILL_SWITCH, "off"],
      [PARENT, "off"],
      [CHILD, "on"],
    ],
  },
  {
    name: "override: kill switch on explicitly",
    why: "an override equal to the hard default is a no-op for values but still reported as an override",
    audience: "self",
    goals: {},
    overrides: [[KILL_SWITCH, "on"]],
  },
  {
    name: "override: parent set to a value that is not on/off",
    why: "override_value is an unchecked cast — it is echoed verbatim, and `parentValue !== 'on'` still collapses the dependents",
    audience: "self",
    goals: {},
    overrides: [[PARENT, "banana"]],
  },
  {
    name: "override: override equal to the resolved value",
    why: "override non-null, currentValue === focusValue",
    audience: "self",
    goals: { monitor: true },
    overrides: [["flag.global.keyboard_shortcuts", "on"]],
  },
  {
    name: "override: unknown key",
    why: "getAllOverrides drops keys the registry does not know, so nothing changes and no row carries it",
    audience: "self",
    goals: {},
    overrides: [["flag.not.a.real.flag", "on"]],
  },
  {
    name: "override: quarantined-looking value on the desktop flag under web runtime",
    why: "the runtime rule (step 5) runs BEFORE the override (step 7), so an override off wins over the forced on",
    audience: "self",
    goals: {},
    runtime: "desktop",
    overrides: [["flag.desktop.app_section", "off"]],
  },
  {
    name: "audience is not one of the three",
    why: "AUDIENCE_RULES[audience] is undefined and indexing it throws — the route answers 500 {error:'Failed to list flags'}",
    audience: "banana",
    goals: {},
  },
  {
    name: "audience is an Object.prototype property name",
    why: "AUDIENCE_RULES['constructor'] is a FUNCTION, not undefined, so the lookup does not throw and no audience rule applies",
    audience: "constructor",
    goals: {},
  }
);
if (grandchild) {
  CONTEXTS.push({
    name: "override: grandparent off",
    why: `${grandchild} → ${deps[grandchild]} → ${deps[deps[grandchild]]}: the collapse recurses through two levels`,
    audience: "self",
    goals: { monitor: true, cleanup: true },
    overrides: [[deps[deps[grandchild]], "off"]],
  });
}

const rowKey = (r) => JSON.stringify(r);
let reference = null;
const flagCases = CONTEXTS.map((c) => {
  let rows = null;
  let throws = null;
  try {
    rows = buildRows(contextOf(c));
  } catch (e) {
    throws = e?.constructor?.name ?? "Error";
  }
  const base = {
    name: c.name,
    why: c.why,
    audience: c.audience,
    goals: c.goals,
    runtime: c.runtime ?? null,
    overrides: c.overrides ?? [],
    throws,
  };
  if (throws) {
    return base;
  }
  if (!reference) {
    reference = rows;
    return { ...base, rows };
  }
  // The row ORDER is value-independent, and `surface` / `hardDefault` /
  // `wired` are functions of the key alone — the reference context pins all
  // four. So every other context records only the rows whose content
  // differs from the reference, and only the three fields that can differ.
  // The Rust test checks the order of every case against the reference
  // separately, and asserts the delta is exactly this set.
  const byKey = new Map(reference.map((r) => [r.key, rowKey(r)]));
  const delta = rows
    .filter((r) => byKey.get(r.key) !== rowKey(r))
    .map(({ key, currentValue, focusValue, override }) => ({
      key,
      currentValue,
      focusValue,
      override,
    }));
  return { ...base, delta };
});

// The collation the sort relies on, pinned on its own: the exact key order
// Node produces for the full registry, and for the surfaces. The Rust port
// reproduces ICU's root collation for ASCII (punctuation < digits < letters,
// case-insensitive at the primary level); this is what it is held to.
const sortedKeys = [...Object.keys(rules.HARD_DEFAULTS)].sort((a, b) =>
  a.localeCompare(b)
);
const sortedSurfaces = [
  ...new Set(Object.keys(rules.HARD_DEFAULTS).map(surfaceOf)),
].sort((a, b) => a.localeCompare(b));
// Every printable ASCII character in localeCompare order — the primary
// weights the Rust model is built from, so a change of ICU version in Node
// shows up here rather than as an unexplained resort.
const asciiOrder = Array.from({ length: 94 }, (_, i) =>
  String.fromCharCode(33 + i)
)
  .sort((a, b) => a.localeCompare(b))
  .join("");

// ── write ───────────────────────────────────────────────────────────────

const rulesFile = path.join(repo, "core", "src", "server", "flag_rules.json");
writeFileSync(rulesFile, `${JSON.stringify(flagRules, null, 2)}\n`);

const outDir = path.join(repo, "core", "tests", "fixtures");
mkdirSync(outDir, { recursive: true });
const casesFile = path.join(outDir, "settings-cases.json");
writeFileSync(
  casesFile,
  `${JSON.stringify(
    {
      generated_by: "core/scripts/extract-settings-cases.mjs",
      note: "DO NOT EDIT BY HAND. Regenerate with `just parity-settings-cases`; every expected value is the real Node function's output.",
      webhook_masks: {
        source:
          "app/api/settings/route.ts → maskWebhookUrl (source text lifted and executed)",
        cases: webhookMasks,
      },
      layouts: {
        source:
          "lib/dashboard-layout.ts → reconcileLayout, matchDashboardPreset, DASHBOARD_PRESETS",
        tables: layoutTables,
        cases: layouts,
      },
      flags: {
        source:
          "lib/feature-flags.ts → resolveFlag, resolveFocusBaseline over app/api/feature-flags/route.ts's row shape",
        collation: {
          ascii_order: asciiOrder,
          sorted_keys: sortedKeys,
          sorted_surfaces: sortedSurfaces,
        },
        cases: flagCases,
      },
    },
    null,
    2
  )}\n`
);

const deltas = flagCases.reduce((n, c) => n + (c.delta?.length ?? 0), 0);
const throwing = flagCases.filter((c) => c.throws).length;
console.log(
  `extract-settings-cases: wrote ${Object.keys(rules.HARD_DEFAULTS).length} flag keys to ${path.relative(repo, rulesFile)}; ${webhookMasks.length} webhook masks, ${layouts.length} layouts, ${flagCases.length} flag contexts (${deltas} delta rows, ${throwing} that Node throws on) to ${path.relative(repo, casesFile)}`
);
