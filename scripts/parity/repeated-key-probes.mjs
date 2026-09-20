/**
 * Repeated query keys, live on both servers.
 *
 * Node reads every query parameter with `searchParams.get(key)`, which
 * returns the FIRST value of a repeated key. Five core handlers used to
 * extract the query as `Query<HashMap<String, String>>`, which keeps the
 * LAST, so `?x=a&x=b` answered differently on the two backends without
 * any read in the manifest noticing: the manifest's paths each name a key
 * once. They now use `routes_stats::Params` (a `Vec` of pairs) with its
 * first-match `get`, as the later routes always did.
 *
 * Each case is a repeated key whose FIRST and LAST values give DIFFERENT
 * answers on the gate's data. Three requests go to BOTH servers — the
 * repeated key, the first value alone, the last value alone — and a case
 * passes only when:
 *
 *   1. the two servers agree on all three, byte for byte;
 *   2. the repeated answer IS the first value's, byte for byte, and
 *      satisfies the `first` predicate. The predicate is what stops a run
 *      passing with both sides wrong in the same way, since equality alone
 *      cannot tell which value was taken;
 *   3. the last value alone answers DIFFERENTLY, and satisfies `last`. So
 *      the case is still discriminating on whatever data the gate carries,
 *      rather than having quietly become two names for one answer.
 *
 * `/api/diagnostics/errors?limit=` is the sixth handler and is NOT here:
 * its answer is a slice of a per-process ring, Node's ring is empty in
 * production (see `probeErrorRing` in read-parity.mjs for why), and the
 * two servers therefore cannot be compared on it at all. Its first-wins
 * assertion lives in that probe, against the Rust ring's own length.
 *
 * Nothing here writes. Runs with the other read probes.
 */

import { TIMELINE_ID } from "./since-install-fixture.mjs";
import { STATS_IDS } from "./stats-fixture.mjs";

/** The devices fixture's first import row, and an app with two verdicts. */
const IMPORT_ID = "pt-device-reads-import-0";
const VERDICT_APP = STATS_IDS[0];
/** 2100-01-01: later than every fixture row. */
const FUTURE_MS = "4102444800000";
const DAY_MS = "86400000";

const CASES = [
  {
    // `if (id)` is a truthiness test, so the empty first value falls
    // through to the list. The HashMap read `imp-0` and answered the
    // detail object.
    claim: "/api/imports keeps the empty ?id= over a real one",
    repeated: `/api/imports?id=&id=${IMPORT_ID}`,
    firstOnly: "/api/imports?id=",
    first: (j, status) =>
      status === 200 &&
      Array.isArray(j) &&
      j.some((row) => row.id === IMPORT_ID),
    lastOnly: `/api/imports?id=${IMPORT_ID}`,
    last: (j, status) =>
      status === 200 && !Array.isArray(j) && j.import?.id === IMPORT_ID,
  },
  {
    // Same truthiness test, opposite direction: the empty value is the
    // 400, and the real app id after it must not rescue the request.
    claim: "/api/verdicts keeps the empty ?appId= over a real one",
    repeated: `/api/verdicts?appId=&appId=${VERDICT_APP}`,
    firstOnly: "/api/verdicts?appId=",
    first: (j, status) => status === 400 && j.error === "appId is required",
    lastOnly: `/api/verdicts?appId=${VERDICT_APP}`,
    last: (j, status) => status === 200 && j.verdicts?.length > 0,
  },
  {
    // `Number("")` is 0, so an empty `before` is VALID and means "older
    // than the epoch" — an empty page, not the whole timeline.
    claim: "/api/apps/[id]/changelog keeps the empty ?before= over a date",
    repeated: `/api/apps/${TIMELINE_ID}/changelog?before=&before=${FUTURE_MS}`,
    firstOnly: `/api/apps/${TIMELINE_ID}/changelog?before=`,
    first: (j, status) =>
      status === 200 && j.rows?.length === 0 && j.hasMore === false,
    lastOnly: `/api/apps/${TIMELINE_ID}/changelog?before=${FUTURE_MS}`,
    last: (j, status) => status === 200 && j.rows?.length > 0,
  },
  {
    // `parseInt("")` is NaN, and this parameter is checked for presence,
    // so the empty value is a 400 rather than the default page size.
    claim: "/api/apps/[id]/changelog keeps the empty ?limit= over a number",
    repeated: `/api/apps/${TIMELINE_ID}/changelog?limit=&limit=5`,
    firstOnly: `/api/apps/${TIMELINE_ID}/changelog?limit=`,
    first: (j, status) =>
      status === 400 &&
      j.error === "`limit` must be an integer between 1 and 200",
    lastOnly: `/api/apps/${TIMELINE_ID}/changelog?limit=5`,
    last: (j, status) => status === 200 && j.rows?.length > 0,
  },
  {
    claim: "/api/import/audit-bundle/recent keeps the empty ?withinMs=",
    repeated: `/api/import/audit-bundle/recent?withinMs=&withinMs=${DAY_MS}`,
    firstOnly: "/api/import/audit-bundle/recent?withinMs=",
    first: (j, status) =>
      status === 400 &&
      j.error === "withinMs must be an integer in 1..31536000000",
    lastOnly: `/api/import/audit-bundle/recent?withinMs=${DAY_MS}`,
    last: (j, status) => status === 200 && "recent" in j,
  },
];

export async function probeRepeatedKeys(nodeBase, rustBase, token) {
  let ok = true;
  const get = async (base, route) => {
    const res = await fetch(`${base}${route}`, {
      headers: { origin: base, "x-auditor-admin-token": token },
    });
    const body = await res.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    return { status: res.status, body, json };
  };

  const same = (a, b) => a.status === b.status && a.body === b.body;

  for (const c of CASES) {
    const [repeated, firstOnly, lastOnly] = await Promise.all(
      [c.repeated, c.firstOnly, c.lastOnly].map(async (route) => {
        const [node, rust] = await Promise.all([
          get(nodeBase, route),
          get(rustBase, route),
        ]);
        return { route, node, rust };
      })
    );
    const agree = [repeated, firstOnly, lastOnly].every((r) =>
      same(r.node, r.rust)
    );
    // Both sides agreeing says nothing about WHICH value was taken, so the
    // predicate pins the answer, and the last value alone must differ from
    // it — otherwise the case has stopped discriminating.
    const holds = (r, predicate) =>
      predicate(r.node.json ?? {}, r.node.status) &&
      predicate(r.rust.json ?? {}, r.rust.status);
    const isFirst =
      holds(repeated, c.first) && same(repeated.node, firstOnly.node);
    const firstAlone = holds(firstOnly, c.first);
    const lastDiffers =
      holds(lastOnly, c.last) &&
      !holds(lastOnly, c.first) &&
      !same(lastOnly.node, firstOnly.node);
    const pass = agree && isFirst && firstAlone && lastDiffers;
    console.log(
      `  ${pass ? "✔" : "✘"} repeated keys: ${c.claim} (HTTP ${repeated.node.status})`
    );
    if (!pass) {
      const show = (label, r) =>
        `\n      ${label} node ${r.node.status}: ${r.node.body.slice(0, 240)}` +
        `\n      ${label} rust ${r.rust.status}: ${r.rust.body.slice(0, 240)}`;
      console.log(
        `      agree=${agree} isFirst=${isFirst} firstAlone=${firstAlone} lastDiffers=${lastDiffers}` +
          show("repeated", repeated) +
          show("first   ", firstOnly) +
          show("last    ", lastOnly)
      );
    }
    ok = pass && ok;
  }
  return ok;
}
