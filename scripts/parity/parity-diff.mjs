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
 *   --skip-seed      compare as-is without seeding either side
 *   --no-normalize   disable normalisation (self-test: two Node servers
 *                    seeded seconds apart MUST then diff on timestamps —
 *                    proving the differ can fail)
 *   --token <t>      admin token (default: the Playwright default, or
 *                    AUDITOR_ADMIN_TOKEN)
 *
 * Exit code: 0 all entries identical, 1 any diff or HTTP mismatch.
 *
 * Design notes:
 * - Dual-live instead of stored goldens: goldens rot under normaliser
 *   drift; live A/B seeds both sides in the same minute and compares
 *   directly.
 * - The canned fixture's synthetic app ids are content-hashed
 *   (sha1-derived), so ids agree across independent databases — only
 *   row UUIDs and timestamps need normalising.
 * - JSON endpoints only. Page HTML parity is covered by the Playwright
 *   suite + the local visual net, which run against either backend
 *   unchanged.
 */

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    a: { type: "string" },
    b: { type: "string" },
    "skip-seed": { type: "boolean", default: false },
    "no-normalize": { type: "boolean", default: false },
    token: { type: "string" },
  },
});

if (!(args.a && args.b)) {
  console.error(
    "usage: parity-diff.mjs --a <urlA> --b <urlB> [--skip-seed] [--no-normalize]"
  );
  process.exit(2);
}

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

async function call(base, method, path, body) {
  const res = await fetch(base + path, {
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
  for (const [method, path, body] of steps) {
    const { status, text } = await call(base, method, path, body);
    if (status >= 400) {
      throw new Error(
        `seed ${base} ${method} ${path} -> ${status}: ${text.slice(0, 200)}`
      );
    }
  }
}

const EPOCH_MS_MIN = 1_400_000_000_000; // 2014 — anything above is a timestamp
const EPOCH_MS_MAX = 4_100_000_000_000; // 2099
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

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
    if (ISO_RE.test(value)) {
      return "~iso";
    }
    // Embedded uuids (hrefs) and embedded durations ("took 3ms") inside
    // longer strings — e.g. migration-step activity summaries.
    return value
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "~uuid"
      )
      .replace(/\b\d+\s*ms\b/g, "~ms");
  }
  return value;
}

/** Request manifest. `{app}` is replaced per-side with the canned
 * Instagram id resolved from that side's own /api/apps (ids are
 * content-hashed, so both sides agree — resolving per side just keeps
 * the harness honest about it). */
const MANIFEST = [
  { name: "apps (bare array)", path: "/api/apps" },
  {
    name: "apps (paginated + grid meta)",
    path: "/api/apps?limit=250&offset=0&meta=grid",
  },
  { name: "feature flags", path: "/api/feature-flags" },
  { name: "focus", path: "/api/focus" },
  { name: "privacy profile", path: "/api/privacy-profile" },
  { name: "accessibility profile", path: "/api/accessibility-profile" },
  { name: "devices", path: "/api/devices" },
  { name: "notifications", path: "/api/notifications" },
  // Health-check rows are periodic background output (first tick 60 s
  // after boot) — their presence depends on uptime and their detail blob
  // is machine state (RSS, heap, WAL bytes). Compare user/seed activity.
  {
    name: "activity",
    path: "/api/activity",
    transform: (json) => ({
      ...json,
      rows: (json.rows ?? []).filter((r) => r.type !== "health_check"),
      total: undefined,
    }),
  },
  { name: "global changelog", path: "/api/changelog" },
  // Radar orders tie-scored apps nondeterministically (two runs of the
  // SAME implementation flap) — compare as a set, sorted by app id.
  { name: "stats radar", path: "/api/stats/radar", canonicalizeById: true },
  { name: "stats timeline", path: "/api/stats/timeline" },
  { name: "stats matrix", path: "/api/stats/matrix" },
  { name: "sync status", path: "/api/sync/status" },
  { name: "shortlist", path: "/api/shortlist" },
  { name: "manual apps", path: "/api/manual-apps" },
  { name: "since-install (Instagram)", path: "/api/apps/{app}/since-install" },
  { name: "history-stats (Instagram)", path: "/api/apps/{app}/history-stats" },
  { name: "verdicts (Instagram)", path: "/api/verdicts?appId={app}" },
];

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

async function instagramId(base) {
  const { status, text } = await call(base, "GET", "/api/apps");
  if (status !== 200) {
    throw new Error(`${base} /api/apps -> ${status}`);
  }
  const apps = JSON.parse(text);
  const insta = apps.find((a) => a.name === "Instagram");
  if (!insta) {
    throw new Error(`${base}: no canned Instagram — seed first`);
  }
  return String(insta.id);
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

const main = async () => {
  if (!args["skip-seed"]) {
    process.stderr.write("seeding both sides…\n");
    await seed(args.a);
    await seed(args.b);
  }
  const ids = { a: await instagramId(args.a), b: await instagramId(args.b) };
  if (ids.a !== ids.b) {
    console.error(`FATAL: canned Instagram ids differ (${ids.a} vs ${ids.b})`);
    process.exit(1);
  }

  let failures = 0;
  for (const entry of MANIFEST) {
    const path = (side) => entry.path.replaceAll("{app}", ids[side]);
    const [ra, rb] = await Promise.all([
      call(args.a, "GET", path("a")),
      call(args.b, "GET", path("b")),
    ]);
    if (ra.status !== rb.status) {
      console.log(`✘ ${entry.name}: HTTP ${ra.status} vs ${rb.status}`);
      failures++;
      continue;
    }
    if (ra.status !== 200) {
      console.log(
        `✘ ${entry.name}: both returned HTTP ${ra.status} (manifest entry broken?)`
      );
      failures++;
      continue;
    }
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
    if (bodyA === bodyB) {
      console.log(`✔ ${entry.name} (${bodyA.length} bytes)`);
    } else {
      const d = firstDiff(bodyA, bodyB);
      console.log(`✘ ${entry.name}: first diff at normalised line ${d?.line}`);
      console.log(`    A: ${d?.a.slice(0, 160)}`);
      console.log(`    B: ${d?.b.slice(0, 160)}`);
      failures++;
    }
  }
  console.log(
    failures === 0
      ? `\nPARITY OK — ${MANIFEST.length} entries identical`
      : `\nPARITY FAILED — ${failures}/${MANIFEST.length} entries differ`
  );
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error(String(e));
  process.exit(2);
});
