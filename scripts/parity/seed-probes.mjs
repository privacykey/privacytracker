/**
 * The dev seed, live on both servers (Rust core Phase 4, batch 5d).
 *
 * Every other pass starts from ONE seeded database: Node runs the canned
 * seed, the data directory is copied, and the core serves the copy. So
 * the core's own seed is the one write the gate had never watched run.
 * Here each server is emptied and seeds ITSELF, and the two libraries are
 * compared.
 *
 * They cannot be compared byte for byte: the canned seed mints a random
 * id for every label, feature, snapshot and policy version, and stamps
 * each app with its own clock. So the comparison is of what the seed
 * DECIDED — every column that is not a random id, every timestamp as its
 * distance from the app's own `lastSynced` (the one `Date.now()` the seed
 * reads per app), every child row under its parent's natural key. Two
 * seeds that agree on all of that built the same library.
 *
 * Runs LAST, after the backup probe: it begins by resetting both servers.
 * Only `?source=canned` is exercised; the live walk scrapes Apple, and a
 * parity run must not depend on a third party.
 */

const DAY = 86_400_000;
const SEEDED_TABLES = [
  "apps",
  "privacy_types",
  "privacy_categories",
  "accessibility_features",
  "privacy_policy_analyses",
  "privacy_policy_versions",
  "privacy_snapshots",
];

/**
 * A server's seeded library with the random ids and the clock taken out.
 */
function libraryOf(tables) {
  const rows = (name) => tables[name]?.rows ?? [];
  const syncedAt = new Map(rows("apps").map((a) => [a.id, a.lastSynced]));
  const since = (appId, at) =>
    at === null || at === undefined ? at : at - syncedAt.get(appId);
  const typeOf = new Map(
    rows("privacy_types").map((t) => [t.id, `${t.app_id}/${t.identifier}`])
  );
  const sorted = (list) =>
    list.map((row) => JSON.stringify(row)).sort((a, b) => a.localeCompare(b));
  return {
    apps: sorted(
      rows("apps").map((a) => ({
        ...a,
        firstSeen: a.firstSeen - a.lastSynced,
        lastSynced: "now",
      }))
    ),
    privacy_types: sorted(rows("privacy_types").map(({ id: _id, ...t }) => t)),
    privacy_categories: sorted(
      rows("privacy_categories").map(({ id: _id, type_id, ...c }) => ({
        type: typeOf.get(type_id) ?? `unknown type ${type_id}`,
        ...c,
      }))
    ),
    accessibility_features: sorted(
      rows("accessibility_features").map(({ id: _id, ...f }) => f)
    ),
    privacy_policy_analyses: sorted(
      rows("privacy_policy_analyses").map((p) => ({
        ...p,
        updated_at: since(p.app_id, p.updated_at),
        source_fetched_at: since(p.app_id, p.source_fetched_at),
        previous_summary_at: since(p.app_id, p.previous_summary_at),
      }))
    ),
    privacy_policy_versions: sorted(
      rows("privacy_policy_versions").map(({ id: _id, ...v }) => ({
        ...v,
        first_fetched_at: since(v.app_id, v.first_fetched_at),
        last_fetched_at: since(v.app_id, v.last_fetched_at),
      }))
    ),
    privacy_snapshots: sorted(
      rows("privacy_snapshots").map(({ id: _id, ...s }) => ({
        ...s,
        scraped_at: since(s.app_id, s.scraped_at),
      }))
    ),
  };
}

export async function probeSeedRoute(nodeBase, rustBase, token) {
  let ok = true;
  const check = (claim, pass, detail = "") => {
    console.log(`  ${pass ? "✔" : "✘"} seed: ${claim}`);
    if (!pass && detail) {
      console.log(`    ${detail}`);
    }
    ok = pass && ok;
    return pass;
  };
  const send = async (base, method, route, headers = {}) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { origin: base, "x-auditor-admin-token": token, ...headers },
    });
    return { status: res.status, text: await res.text() };
  };
  const both = (...args) =>
    Promise.all([send(nodeBase, ...args), send(rustBase, ...args)]);
  const short = (r) => JSON.stringify(r).slice(0, 400);
  // The one figure of the response that is each process's own.
  const timed = (r) => {
    try {
      const { durationMs, ...rest } = JSON.parse(r.text);
      return {
        body: JSON.stringify(rest),
        timed: Number.isInteger(durationMs) && durationMs >= 0,
      };
    } catch {
      return { body: r.text, timed: false };
    }
  };

  // ── the guard, which no other pass sees refuse ─────────────────────
  const [bareNode, bareRust] = await both(
    "POST",
    "/api/dev/seed-sample-data?source=canned",
    { "x-auditor-admin-token": "not-the-token" }
  );
  check(
    "the seed is refused identically without the admin token",
    bareNode.status === 401 &&
      bareRust.status === 401 &&
      bareNode.text === bareRust.text,
    `node=${short(bareNode)} rust=${short(bareRust)}`
  );

  // ── empty both, then let each seed itself ──────────────────────────
  const [resetNode, resetRust] = await both("POST", "/api/reset");
  if (
    !check(
      "both servers reset to an empty library",
      resetNode.status === 200 &&
        resetRust.status === 200 &&
        resetNode.text === resetRust.text,
      `node=${short(resetNode)} rust=${short(resetRust)}`
    )
  ) {
    return false;
  }
  const [seedNode, seedRust] = await both(
    "POST",
    "/api/dev/seed-sample-data?source=canned&country=nz"
  );
  const a = timed(seedNode);
  const b = timed(seedRust);
  let inserted = 0;
  try {
    inserted = JSON.parse(seedRust.text).inserted;
  } catch {
    // Reported by the check below.
  }
  check(
    `each server seeds itself and answers identically (${inserted} apps inserted, the region echoed from the query)`,
    seedNode.status === 200 &&
      seedRust.status === 200 &&
      a.body === b.body &&
      a.timed &&
      b.timed &&
      inserted > 0,
    `node=${short(seedNode)} rust=${short(seedRust)}`
  );

  // ── what each of them now holds ────────────────────────────────────
  const [nodeExport, rustExport] = await both("GET", "/api/backup/export");
  let diverged = ["(export failed)"];
  let counted = "";
  if (nodeExport.status === 200 && rustExport.status === 200) {
    const nodeLibrary = libraryOf(JSON.parse(nodeExport.text).tables);
    const rustLibrary = libraryOf(JSON.parse(rustExport.text).tables);
    diverged = SEEDED_TABLES.filter(
      (name) =>
        JSON.stringify(nodeLibrary[name]) !== JSON.stringify(rustLibrary[name])
    );
    counted = SEEDED_TABLES.map(
      (name) => `${rustLibrary[name].length} ${name}`
    ).join(", ");
    // A seed that wrote nothing would agree with itself perfectly.
    check(
      "the core's own seed wrote a whole library: apps, labels, features, policy analyses and versions, and a back-dated timeline",
      SEEDED_TABLES.every((name) => rustLibrary[name].length > 0) &&
        rustLibrary.privacy_snapshots.some(
          (row) => JSON.parse(row).scraped_at <= -30 * DAY
        ),
      counted
    );
  }
  check(
    `the two libraries agree in every seeded table, random ids and each server's clock aside (${counted})`,
    diverged.length === 0,
    `diverged: ${diverged.join(", ")}`
  );

  // ── and again, which must change nothing ───────────────────────────
  const [againNode, againRust] = await both(
    "POST",
    "/api/dev/seed-sample-data?source=canned"
  );
  let skipped = -1;
  try {
    const parsed = JSON.parse(againRust.text);
    skipped = parsed.inserted === 0 ? parsed.skipped : -1;
  } catch {
    // Reported by the check below.
  }
  check(
    "a second seed inserts nothing and skips every app, identically",
    againNode.status === 200 &&
      againRust.status === 200 &&
      timed(againNode).body === timed(againRust).body &&
      skipped === inserted,
    `node=${short(againNode)} rust=${short(againRust)}`
  );
  return ok;
}
