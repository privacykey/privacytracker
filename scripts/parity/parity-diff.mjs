#!/usr/bin/env node
/**
 * Dual-live API parity differ — the correctness gate for the Rust core
 * migration (see core/README.md on the rust-core branch).
 *
 * Boots nothing itself. Point it at two RUNNING servers (today:
 * Node-vs-Node as the harness self-test; later: Node-vs-Rust as the
 * cutover gate). It seeds BOTH sides identically (reset → focus →
 * privacy profile → accessibility profile → canned sample data — the
 * same sequence the e2e suite uses), replays the same request manifest
 * against both, normalises fields that are legitimately volatile
 * (epoch-ms timestamps, UUIDs, ISO dates), and fails on any remaining
 * byte difference.
 *
 *   node scripts/parity/parity-diff.mjs --a http://127.0.0.1:3001 --b http://127.0.0.1:3002
 *
 * Flags:
 *   --a / --b        base URLs of the two servers (required)
 *   --mutate         also replay the write manifest (POST/PUT/PATCH/
 *                    DELETE). OFF by default — see "Safety" below.
 *   --teardown       also replay the destructive group (reset, wipe,
 *                    start-over). Implies --mutate. OFF by default.
 *   --skip-seed      compare as-is without seeding either side
 *   --no-normalize   disable normalisation (self-test: two Node servers
 *                    seeded seconds apart MUST then diff on timestamps —
 *                    proving the differ can fail)
 *   --skip-coverage  don't enforce the manifest coverage gate
 *   --token <t>      admin token (default: the Playwright default, or
 *                    AUDITOR_ADMIN_TOKEN)
 *
 * Exit code: 0 all entries identical, 1 any diff or HTTP mismatch,
 * 2 harness error (including a coverage-gate failure).
 *
 * ── Safety ──────────────────────────────────────────────────────────
 * Writes are opt-in because the manifest contains `/api/reset`,
 * `/api/admin/start-over` and `DELETE /api/apps`. A bare invocation is
 * read-only and cannot damage whatever it is pointed at; full coverage
 * requires you to ask for it. CI and the self-test pass --teardown.
 *
 * ── Coverage ────────────────────────────────────────────────────────
 * scripts/parity/manifest.mjs classifies every route under app/api. At
 * startup this script walks the filesystem and fails if any route.ts is
 * unlisted — the manifest previously covered 17 of 120 routes and the
 * surface grew from 110 to 120 with nothing noticing. Adding a route now
 * forces a classification decision in the same PR.
 *
 * ── Design notes ────────────────────────────────────────────────────
 * - Dual-live instead of stored goldens: goldens rot under normaliser
 *   drift; live A/B seeds both sides in the same minute and compares
 *   directly.
 * - The canned fixture's synthetic app ids are content-hashed
 *   (sha1-derived), so ids agree across independent databases — only
 *   row UUIDs and timestamps need normalising. Ids created *during* the
 *   run (annotations, devices, manual apps) are NOT content-hashed, so
 *   they are resolved per-side and compared structurally, never by value.
 * - Writes compare two things: the response envelope, AND — via an
 *   entry's `after` — the state a follow-up GET reports. A write that
 *   returns a plausible 200 but persists differently is precisely what
 *   a port produces, and response-only comparison sails past it.
 * - JSON endpoints only. Page HTML parity is covered by the Playwright
 *   suite + the local visual net, which run against either backend
 *   unchanged.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  MUTATIONS,
  QUARANTINE,
  READS,
  TEARDOWN,
  VOLATILE_READS,
} from "./manifest.mjs";

const { values: args } = parseArgs({
  options: {
    a: { type: "string" },
    b: { type: "string" },
    mutate: { type: "boolean", default: false },
    teardown: { type: "boolean", default: false },
    "skip-seed": { type: "boolean", default: false },
    "no-normalize": { type: "boolean", default: false },
    "skip-coverage": { type: "boolean", default: false },
    // Opt-in route filter, for comparing a backend that only implements
    // SOME routes yet (the Rust core lands them in batches). Without it
    // every unimplemented route fails on "HTTP 200 vs 404" and drowns the
    // real signal. The full run remains the default and the coverage gate
    // is untouched — this narrows what is REQUESTED, never what is listed.
    only: { type: "string" },
    // Resolve every {placeholder} from ONE side instead of each side
    // independently. Correct only when the two servers share a database —
    // read-parity.mjs copies Node's file for the Rust side, so the rows are
    // identical by construction and side B may not even implement the route
    // the resolver reads. Off by default: two independently seeded servers
    // must still agree on their own, which is what the id cross-check proves.
    "ids-from": { type: "string" },
    token: { type: "string" },
  },
});

if (!(args.a && args.b)) {
  console.error(
    "usage: parity-diff.mjs --a <urlA> --b <urlB> [--mutate] [--teardown] [--skip-seed] [--no-normalize]"
  );
  process.exit(2);
}
const runMutations = args.mutate || args.teardown;

/** Filter a manifest group by the --only regex, when one was given. */
const onlyRe = args.only ? new RegExp(args.only) : null;
const selected = (entries) =>
  onlyRe ? entries.filter((e) => onlyRe.test(e.route)) : entries;

const TOKEN =
  args.token ??
  process.env.AUDITOR_ADMIN_TOKEN ??
  "privacytracker-playwright-token";

const headers = (base) => ({
  origin: base,
  "x-auditor-admin-token": TOKEN,
  "content-type": "application/json",
});

/** The Strict privacy profile + a11y profile the e2e suite uses. */
const PRIVACY_PROFILE = {
  CONTACT_INFO: "not_linked",
  HEALTH_AND_FITNESS: "not_collected",
  FINANCIAL_INFO: "not_linked",
  LOCATION: "not_collected",
  SENSITIVE_INFO: "not_collected",
  CONTACTS: "not_collected",
  USER_CONTENT: "not_linked",
  BROWSING_HISTORY: "not_collected",
  SEARCH_HISTORY: "not_linked",
  IDENTIFIERS: "not_linked",
  PURCHASES: "not_linked",
  USAGE_DATA: "not_linked",
  DIAGNOSTICS: "not_linked",
  OTHER: "not_collected",
};
const A11Y_PROFILE = {
  voiceover: "required",
  voice_control: "required",
  captions: "nice",
};

async function call(base, method, path_, body) {
  const res = await fetch(base + path_, {
    method,
    headers: headers(base),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function seed(base) {
  const steps = [
    ["POST", "/api/reset"],
    [
      "POST",
      "/api/focus",
      {
        audience: "self",
        monitor: true,
        cleanup: false,
        minimal: false,
        accessibility: true,
      },
    ],
    ["PUT", "/api/privacy-profile", { profile: PRIVACY_PROFILE }],
    ["PUT", "/api/accessibility-profile", { profile: A11Y_PROFILE }],
    ["POST", "/api/dev/seed-sample-data?source=canned"],
  ];
  for (const [method, path_, body] of steps) {
    const { status, text } = await call(base, method, path_, body);
    if (status >= 400) {
      throw new Error(
        `seed ${base} ${method} ${path_} -> ${status}: ${text.slice(0, 200)}`
      );
    }
  }
}

const EPOCH_MS_MIN = 1_400_000_000_000; // 2014 — anything above is a timestamp
const EPOCH_MS_MAX = 4_100_000_000_000; // 2099
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keys whose numeric values are wall-clock durations (how long the
// seed/scrape itself took) — legitimately different between two runs.
const DURATION_KEY_RE = /(durationMs|elapsedMs|_ms)$/i;

function normalize(value, key = "") {
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v, key));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalize(v, k);
    }
    return out;
  }
  if (typeof value === "number" && DURATION_KEY_RE.test(key)) {
    return "~ms";
  }
  if (
    typeof value === "number" &&
    value > EPOCH_MS_MIN &&
    value < EPOCH_MS_MAX
  ) {
    return "~epoch";
  }
  if (typeof value === "string") {
    if (UUID_RE.test(value)) {
      return "~uuid";
    }
    // Embedded uuids (hrefs), durations ("took 3ms"), and ISO datetimes
    // inside longer strings — e.g. migration-step activity summaries.
    // The ISO handling REPLACES the matched datetime rather than
    // collapsing the whole string: a value like "2026-08-25T09:00 ·
    // manual" must still differ from "…09:00 · scheduled", or the
    // differ masks a real backend difference in the suffix — exactly
    // the class of bug it exists to catch. A pure timestamp string
    // normalizes to exactly "~iso" either way.
    return (
      value
        .replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          "~uuid"
        )
        .replace(/\b\d+\s*ms\b/g, "~ms")
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[0-9:.]*Z?/g, "~iso")
        // Absolute filesystem paths. The two servers necessarily run from
        // different data directories — and in the real Node-vs-Rust
        // comparison, from different working directories entirely. The
        // path is environment, not behaviour. Anchored to real root dirs
        // so API paths ("/api/apps") and URLs are untouched.
        .replace(
          /\/(?:private|Users|home|var|tmp|opt|app|data)\/[^\s"',;)]*/g,
          "~path"
        )
        // Filename-safe ISO stamps ("…2026-09-08T14-31-02-008Z.json"),
        // which the colon-form regex above cannot match.
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, "~iso")
        // Opaque generated ids that are not uuids — e.g. an import's
        // `imp_RhweIpS7YkZu`. Random per row, so they can never agree
        // across two independent databases; their SHAPE is the contract.
        //
        // The lookahead requiring a digit or capital in the suffix is
        // load-bearing: without it this also swallowed ordinary
        // snake_case enum VALUES such as `not_collected`, so the differ
        // could not tell one privacy tier from another and a backend
        // returning the wrong tier passed. Generated ids always carry a
        // digit or capital; English enum words never do.
        .replace(
          /\b[a-z]{2,6}_(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{8,}/g,
          "~id"
        )
    );
  }
  return value;
}

/** Deep-sort every array of `{id: …}` objects by id — for entries whose
 * ordering is nondeterministic even within one implementation. */
function canonicalizeById(value) {
  if (Array.isArray(value)) {
    const mapped = value.map(canonicalizeById);
    if (mapped.every((v) => v && typeof v === "object" && "id" in v)) {
      mapped.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }
    return mapped;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = canonicalizeById(v);
    }
    return out;
  }
  return value;
}

// ── Placeholder resolution ───────────────────────────────────────────
// `{app}` exists from the canned fixture. The other three name rows this
// run creates, so they resolve lazily and are re-resolved after every
// mutation. Their VALUES are per-side (not content-hashed), so they are
// never compared — only the shape of what they address is.

const appList = async (base) => {
  const { status, text } = await call(base, "GET", "/api/apps");
  if (status !== 200) {
    return [];
  }
  const apps = JSON.parse(text);
  return Array.isArray(apps) ? apps : (apps.apps ?? []);
};

const RESOLVERS = {
  // The admin token is a constant, not a lookup — but it travels through
  // the same substitution machinery so a body can reference it.
  "{token}": async () => TOKEN,
  "{app}": async (base) => {
    const list = await appList(base);
    return String(list.find((a) => a.name === "Instagram")?.id ?? "") || null;
  },
  // A second, DIFFERENT canned app for two-app endpoints (/api/compare).
  // Sorted by id so both sides pick the same one — the canned ids are
  // content-hashed, so sorting is stable across independent databases.
  "{app2}": async (base) => {
    const list = await appList(base);
    const ids = list
      .map((a) => String(a.id))
      .filter(
        (id) => id !== String(list.find((a) => a.name === "Instagram")?.id)
      )
      .sort();
    return ids[0] ?? null;
  },
  "{import}": async (base) => {
    const { status, text } = await call(base, "GET", "/api/imports");
    if (status !== 200) {
      return null;
    }
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : (j.imports ?? j.rows ?? []);
    return list.length ? String(list[0].id) : null;
  },
  "{manualApp}": async (base) => {
    const { status, text } = await call(base, "GET", "/api/manual-apps");
    if (status !== 200) {
      return null;
    }
    const j = JSON.parse(text);
    const list = Array.isArray(j)
      ? j
      : (j.apps ?? j.manualApps ?? j.rows ?? []);
    return list.length ? String(list[0].id) : null;
  },
  "{device}": async (base) => {
    const { status, text } = await call(base, "GET", "/api/devices");
    if (status !== 200) {
      return null;
    }
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : (j.devices ?? j.rows ?? []);
    return list.length ? String(list[0].id) : null;
  },
  "{annotation}": async (base) => {
    const { status, text } = await call(base, "GET", "/api/annotations");
    if (status !== 200) {
      return null;
    }
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : (j.annotations ?? j.rows ?? []);
    return list.length ? String(list[0].id) : null;
  },
};

const placeholdersIn = (s) =>
  Object.keys(RESOLVERS).filter((p) => s.includes(p));

/** Resolve every placeholder an entry needs, on one side. Returns null
 * when something it needs does not exist yet on that side. */
async function resolveFor(base, strings) {
  const needed = [...new Set(strings.flatMap(placeholdersIn))];
  const out = {};
  for (const p of needed) {
    // --ids-from pins resolution to one side; see the flag's note above.
    const from =
      args["ids-from"] === "a"
        ? args.a
        : args["ids-from"] === "b"
          ? args.b
          : base;
    const v = await RESOLVERS[p](from);
    if (v === null) {
      return null;
    }
    out[p] = v;
  }
  return out;
}

const substitute = (s, map) => {
  let out = s;
  for (const [p, v] of Object.entries(map)) {
    out = out.replaceAll(p, v);
  }
  return out;
};

/** Bodies can carry placeholders too (`{ appId: "{app}" }`). */
function substituteDeep(value, map) {
  if (typeof value === "string") {
    return substitute(value, map);
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteDeep(v, map));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substituteDeep(v, map);
    }
    return out;
  }
  return value;
}

function firstDiff(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return { line: i + 1, a: la[i] ?? "<missing>", b: lb[i] ?? "<missing>" };
    }
  }
  return null;
}

// ── Coverage gate ────────────────────────────────────────────────────

function diskRoutes(dir = "app/api", acc = new Set()) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      diskRoutes(p, acc);
    } else if (e.name === "route.ts") {
      acc.add(`/${path.relative("app", path.dirname(p))}`);
    }
  }
  return acc;
}

function checkCoverage() {
  const disk = diskRoutes();
  const listed = new Set();
  for (const group of [
    READS,
    VOLATILE_READS,
    MUTATIONS,
    TEARDOWN,
    QUARANTINE,
  ]) {
    for (const e of group) {
      listed.add(e.route);
    }
  }

  const missing = [...disk].filter((r) => !listed.has(r)).sort();
  const phantom = [...listed].filter((r) => !disk.has(r)).sort();

  if (missing.length || phantom.length) {
    console.error("COVERAGE GATE FAILED");
    if (missing.length) {
      console.error(
        `\n${missing.length} route(s) exist under app/api but are not in scripts/parity/manifest.mjs:`
      );
      for (const r of missing) {
        console.error(`  ${r}`);
      }
      console.error(
        "\nAdd each to READS, VOLATILE_READS, MUTATIONS, TEARDOWN or QUARANTINE."
      );
    }
    if (phantom.length) {
      console.error(`\n${phantom.length} manifest route(s) no longer exist:`);
      for (const r of phantom) {
        console.error(`  ${r}`);
      }
    }
    process.exit(2);
  }
  return disk.size;
}

// ── Comparison ───────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, skipped: [], exercised: new Set() };

/** Values captured from earlier mutation responses, per side. Lets a
 * write chain onto the id a previous write minted (acknowledge → undo).
 * Captured values are per-side by construction and never compared. */
const captured = { a: {}, b: {} };

/** `after` re-reads a GET the manifest already describes, so it must be
 * compared with that GET's own rules — otherwise a route whose read
 * needs a transform (activity, the diagnostics family) diffs on exactly
 * the machine state the manifest already declared as volatile. Keyed on
 * the path with its query stripped. */
const READ_RULES = new Map();
for (const e of [...READS, ...VOLATILE_READS]) {
  READ_RULES.set(e.path.split("?")[0], e);
}
const rulesFor = (path_) => READ_RULES.get(path_.split("?")[0]) ?? {};

function compareBodies(entry, ra, rb) {
  let bodyA = ra.text;
  let bodyB = rb.text;
  try {
    let ja = JSON.parse(ra.text);
    let jb = JSON.parse(rb.text);
    if (entry.transform) {
      ja = entry.transform(ja);
      jb = entry.transform(jb);
    }
    if (entry.canonicalizeById) {
      ja = canonicalizeById(ja);
      jb = canonicalizeById(jb);
    }
    const na = args["no-normalize"] ? ja : normalize(ja);
    const nb = args["no-normalize"] ? jb : normalize(jb);
    bodyA = JSON.stringify(na, null, 1);
    bodyB = JSON.stringify(nb, null, 1);
  } catch {
    // non-JSON body — compare raw
  }
  return { bodyA, bodyB };
}

/** Run one entry against both sides and report. `method` defaults to GET. */
async function runEntry(entry, { expect200 = true } = {}) {
  const label = entry.name ?? `${entry.method ?? "GET"} ${entry.route}`;
  const strings = [
    entry.path,
    JSON.stringify(entry.body ?? null),
    entry.after ?? "",
  ];

  let [ma, mb] = await Promise.all([
    resolveFor(args.a, strings),
    resolveFor(args.b, strings),
  ]);
  if (ma && mb) {
    ma = { ...ma, ...captured.a };
    mb = { ...mb, ...captured.b };
  }
  // A captured placeholder that was never minted would otherwise be sent
  // through verbatim and read as a literal id, producing a confusing 404
  // instead of a clear ordering error.
  const unmet = [
    ...new Set(strings.join(" ").match(/\{[a-zA-Z]+\}/g) ?? []),
  ].filter((ph) => !(ph in RESOLVERS) && ma && !(ph in ma));
  if (unmet.length) {
    console.log(
      `✘ ${label}: ${unmet.join(", ")} never captured — check ordering`
    );
    results.fail++;
    return;
  }
  if (ma === null || mb === null) {
    if (ma === null && mb === null) {
      results.skipped.push(`${label} (placeholder unresolved on both sides)`);
      console.log(`○ ${label}: skipped — referenced row does not exist yet`);
      return;
    }
    console.log(
      `✘ ${label}: placeholder resolved on ${ma ? "A" : "B"} only — state diverged`
    );
    results.fail++;
    return;
  }

  const method = entry.method ?? "GET";
  const pathA = substitute(entry.path, ma);
  const pathB = substitute(entry.path, mb);
  const bodyA = entry.body ? substituteDeep(entry.body, ma) : undefined;
  const bodyB = entry.body ? substituteDeep(entry.body, mb) : undefined;

  const [ra, rb] = await Promise.all([
    call(args.a, method, pathA, bodyA),
    call(args.b, method, pathB, bodyB),
  ]);
  results.exercised.add(entry.route);

  if (ra.status !== rb.status) {
    console.log(`✘ ${label}: HTTP ${ra.status} vs ${rb.status}`);
    results.fail++;
    return;
  }
  if (expect200 && ra.status >= 400 && !entry.allowErrorStatus) {
    console.log(
      `✘ ${label}: both returned HTTP ${ra.status} (manifest entry broken?)`
    );
    results.fail++;
    return;
  }

  if (!entry.compareStatusOnly) {
    const { bodyA: na, bodyB: nb } = compareBodies(entry, ra, rb);
    if (na !== nb) {
      const d = firstDiff(na, nb);
      console.log(`✘ ${label}: first diff at normalised line ${d?.line}`);
      console.log(`    A: ${d?.a.slice(0, 160)}`);
      console.log(`    B: ${d?.b.slice(0, 160)}`);
      results.fail++;
      return;
    }
  }

  // Compare the persisted state a write produced, not just its envelope.
  if (entry.after) {
    const afterA = substitute(entry.after, ma);
    const afterB = substitute(entry.after, mb);
    const [fa, fb] = await Promise.all([
      call(args.a, "GET", afterA),
      call(args.b, "GET", afterB),
    ]);
    if (fa.status !== fb.status) {
      console.log(
        `✘ ${label} → after ${entry.after}: HTTP ${fa.status} vs ${fb.status}`
      );
      results.fail++;
      return;
    }
    const { bodyA: na, bodyB: nb } = compareBodies(
      rulesFor(entry.after),
      fa,
      fb
    );
    if (na !== nb) {
      const d = firstDiff(na, nb);
      console.log(
        `✘ ${label} → after ${entry.after}: state diverged at line ${d?.line}`
      );
      console.log(`    A: ${d?.a.slice(0, 160)}`);
      console.log(`    B: ${d?.b.slice(0, 160)}`);
      results.fail++;
      return;
    }
  }

  if (entry.capture) {
    for (const [placeholder, pointer] of Object.entries(entry.capture)) {
      for (const [side, res] of [
        ["a", ra],
        ["b", rb],
      ]) {
        try {
          const dug = pointer
            .split(".")
            .reduce((o, k) => o?.[k], JSON.parse(res.text));
          if (dug !== undefined && dug !== null) {
            captured[side][placeholder] = String(dug);
          }
        } catch {
          // non-JSON or missing field — the dependent entry will report
          // an unresolved placeholder rather than silently passing.
        }
      }
    }
  }

  console.log(`✔ ${label}${entry.compareStatusOnly ? " (status only)" : ""}`);
  results.pass++;
}

/** Quarantined routes: agree on status, don't compare the body. */
async function runQuarantine(entry) {
  const label = `${entry.method} ${entry.route}`;
  // Only probe methods that cannot reach a third party or destroy state.
  // A quarantined route's body is untestable here by definition; what IS
  // testable is that both implementations route it, gate it and allow the
  // same methods. We assert that with an OPTIONS-style probe: a HEAD on a
  // GET route, and nothing at all on write routes (issuing the write is
  // precisely what quarantine forbids).
  if (!entry.method.split(",").includes("GET")) {
    results.skipped.push(`${label} — ${entry.why}`);
    return;
  }
  const [ra, rb] = await Promise.all([
    call(args.a, "HEAD", entry.route),
    call(args.b, "HEAD", entry.route),
  ]);
  results.exercised.add(entry.route);
  if (ra.status !== rb.status) {
    console.log(`✘ ${label} (HEAD probe): HTTP ${ra.status} vs ${rb.status}`);
    results.fail++;
    return;
  }
  console.log(`◐ ${label}: status ${ra.status} agrees (body quarantined)`);
  results.pass++;
}

const main = async () => {
  const total = args["skip-coverage"] ? diskRoutes().size : checkCoverage();

  if (!args["skip-seed"]) {
    process.stderr.write("seeding both sides…\n");
    await seed(args.a);
    await seed(args.b);
  }

  // The canned-app id must agree across the two sides before anything that
  // addresses a row by id can be trusted. Skip it when NOTHING selected uses
  // a placeholder — otherwise a --only run over placeholder-free routes fails
  // on a precondition it does not depend on (and, against a backend that has
  // not implemented /api/apps yet, on a route it was never asked to compare).
  const needsPlaceholders = [
    ...selected(READS),
    ...selected(VOLATILE_READS),
    ...(runMutations ? selected(MUTATIONS) : []),
    ...(args.teardown ? selected(TEARDOWN) : []),
  ].some((e) =>
    [e.path, JSON.stringify(e.body ?? null), e.after ?? ""].some((str) =>
      /\{[a-zA-Z]+\}/.test(str ?? "")
    )
  );
  if (needsPlaceholders && args["ids-from"]) {
    console.log(
      `\n--ids-from ${args["ids-from"]}: placeholders resolved from one side only (the two servers share a database), so the id cross-check is skipped`
    );
  } else if (needsPlaceholders) {
    const ids = {
      a: await RESOLVERS["{app}"](args.a),
      b: await RESOLVERS["{app}"](args.b),
    };
    if (ids.a !== ids.b) {
      console.error(
        `FATAL: canned Instagram ids differ (${ids.a} vs ${ids.b})`
      );
      process.exit(1);
    }
  }

  const reads = selected(READS);
  const volatile = selected(VOLATILE_READS);
  const quarantine = selected(QUARANTINE);
  const mutations = selected(MUTATIONS);
  const teardown = selected(TEARDOWN);
  if (onlyRe) {
    const kept =
      reads.length +
      volatile.length +
      quarantine.length +
      mutations.length +
      teardown.length;
    const all =
      READS.length +
      VOLATILE_READS.length +
      QUARANTINE.length +
      MUTATIONS.length +
      TEARDOWN.length;
    console.log(
      `\n--only ${args.only}: ${kept}/${all} manifest entries selected (the rest are NOT compared)`
    );
  }

  console.log(`\n── reads (${reads.length}) ──`);
  for (const entry of reads) {
    await runEntry(entry);
  }

  console.log(`\n── reads with volatility transforms (${volatile.length}) ──`);
  for (const entry of volatile) {
    await runEntry(entry);
  }

  console.log(`\n── quarantined (${quarantine.length}) ──`);
  for (const entry of quarantine) {
    await runQuarantine(entry);
  }

  if (runMutations) {
    console.log(`\n── mutations (${mutations.length}) ──`);
    for (const entry of mutations) {
      await runEntry(entry);
    }
  } else {
    console.log(
      `\n── mutations (${MUTATIONS.length}) — SKIPPED, pass --mutate to run ──`
    );
  }

  if (args.teardown) {
    console.log(`\n── teardown (${teardown.length}) ──`);
    for (const entry of teardown) {
      await runEntry(entry);
    }
  } else {
    console.log(
      `\n── teardown (${TEARDOWN.length}) — SKIPPED, pass --teardown to run ──`
    );
  }

  if (results.skipped.length) {
    console.log(`\n── not exercised (${results.skipped.length}) ──`);
    for (const s of results.skipped) {
      console.log(`  ○ ${s}`);
    }
  }

  const pct = ((results.exercised.size / total) * 100).toFixed(0);
  console.log(
    `\nroutes touched: ${results.exercised.size}/${total} (${pct}%) — checks: ${results.pass} passed, ${results.fail} failed`
  );
  console.log(
    results.fail === 0
      ? "PARITY OK"
      : `PARITY FAILED — ${results.fail} check(s) differ`
  );
  process.exit(results.fail === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error(String(e));
  process.exit(2);
});
