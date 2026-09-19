/**
 * The manual-app policy scrape, live on both servers (Rust core Phase 5,
 * batch 2). A scrape that gets past its checks fetches the manual app's
 * policy from the developer's site, which a parity run must not depend
 * on; the policy-store oracle holds that path. What is held live is what
 * both must answer BEFORE any fetch, in the same words: an id too long,
 * an app that does not exist, an app with no policy URL, and the
 * ten-a-minute limit, whose 429 carries no Retry-After on either side.
 *
 * Runs after the leftovers probe. Nothing here writes: every request is
 * refused before the route reads the policy URL, let alone fetches it.
 */
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { POLICY_MANUAL_NO_URL } from "./policy-fixture.mjs";

export async function probePolicyRoutes(nodeBase, rustBase, token) {
  let ok = true;
  const check = (claim, pass, detail = "") => {
    console.log(`  ${pass ? "✔" : "✘"} policy: ${claim}`);
    if (!pass && detail) {
      console.log(`    ${detail}`);
    }
    ok = pass && ok;
    return pass;
  };
  const send = async (base, route) => {
    const res = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { origin: base, "x-auditor-admin-token": token },
    });
    return {
      status: res.status,
      text: await res.text(),
      type: res.headers.get("content-type"),
      retryAfter: res.headers.get("retry-after"),
    };
  };
  const both = (route) =>
    Promise.all([send(nodeBase, route), send(rustBase, route)]);
  const short = (r) => JSON.stringify(r).slice(0, 300);
  const same = (a, b) =>
    a.status === b.status &&
    a.text === b.text &&
    a.type === b.type &&
    a.retryAfter === b.retryAfter;

  const refusals = [
    [
      "scrape of an id over 128 characters is refused identically",
      `/api/manual-apps/${"m".repeat(129)}/scrape`,
      400,
    ],
    [
      "scrape of a manual app that does not exist is refused identically",
      "/api/manual-apps/pt-policy-missing/scrape",
      404,
    ],
    [
      "scrape of a manual app with no policy URL is refused identically",
      `/api/manual-apps/${POLICY_MANUAL_NO_URL}/scrape`,
      400,
    ],
  ];
  for (const [claim, route, status] of refusals) {
    const [a, b] = await both(route);
    check(
      `${claim} (HTTP ${a.status})`,
      a.status === status && same(a, b),
      `node=${short(a)} rust=${short(b)}`
    );
  }

  // The three refusals above each took a token from the same bucket; the
  // eleventh request in the minute is the first one refused, on both.
  const first429 = { node: null, rust: null };
  let last = [null, null];
  for (let attempt = refusals.length + 1; attempt <= 12; attempt++) {
    last = await both("/api/manual-apps/pt-policy-missing/scrape");
    if (first429.node === null && last[0].status === 429) {
      first429.node = attempt;
    }
    if (first429.rust === null && last[1].status === 429) {
      first429.rust = attempt;
    }
  }
  check(
    `the eleventh scrape in a minute is the first refused, on both (node ${first429.node}, rust ${first429.rust})`,
    first429.node === 11 && first429.rust === 11
  );
  check(
    "the scrape's 429 is identical and carries no Retry-After",
    same(last[0], last[1]) && last[0].retryAfter === null,
    `node=${short(last[0])} rust=${short(last[1])}`
  );
  return ok;
}

/**
 * `POST /api/policy/sync-all`, live on both servers (Rust core Phase 5,
 * batch 4a). A run that gets past its checks fetches every tracked app's
 * developer policy page, which a parity run must not depend on; the
 * policy-runner oracle holds the runs, their resume and their frames.
 * What is held live is everything the route answers before a run: an
 * unparseable and an empty body, a run already under way, the
 * kill-switch, and the four-a-minute limit, whose 429 carries a
 * Retry-After on both. The lock and the kill-switch are written into both
 * databases while the servers run (neither caches settings), and taken
 * out again.
 */
export async function probePolicySyncRoute(
  nodeBase,
  rustBase,
  token,
  nodeData,
  rustData
) {
  let ok = true;
  const check = (claim, pass, detail = "") => {
    console.log(`  ${pass ? "✔" : "✘"} policy sync-all: ${claim}`);
    if (!pass && detail) {
      console.log(`    ${detail}`);
    }
    ok = pass && ok;
    return pass;
  };
  const send = async (base, body) => {
    const res = await fetch(`${base}/api/policy/sync-all`, {
      method: "POST",
      headers: {
        origin: base,
        "x-auditor-admin-token": token,
        "content-type": "application/json",
      },
      body,
    });
    return {
      status: res.status,
      text: await res.text(),
      type: res.headers.get("content-type"),
      retryAfter: res.headers.get("retry-after"),
    };
  };
  const both = (body) =>
    Promise.all([send(nodeBase, body), send(rustBase, body)]);
  const short = (r) => JSON.stringify(r).slice(0, 300);
  const same = (a, b) =>
    a.status === b.status &&
    a.text === b.text &&
    a.type === b.type &&
    a.retryAfter === b.retryAfter;
  // One setting written into both databases, or removed with `null`.
  const setBoth = (key, value) => {
    for (const dir of [nodeData, rustData]) {
      const db = new BetterSqlite3(path.join(dir, "privacy.db"));
      try {
        if (value === null) {
          db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
        } else {
          db.prepare(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
          ).run(key, value);
        }
      } finally {
        db.close();
      }
    }
  };

  let [a, b] = await both("{not json");
  check(
    `an unparseable body is refused identically (HTTP ${a.status})`,
    a.status === 400 && same(a, b),
    `node=${short(a)} rust=${short(b)}`
  );
  [a, b] = await both(undefined);
  check(
    `an empty body is refused identically (HTTP ${a.status})`,
    a.status === 400 && same(a, b),
    `node=${short(a)} rust=${short(b)}`
  );
  setBoth("policy_sync_running", "true");
  try {
    [a, b] = await both("{}");
  } finally {
    setBoth("policy_sync_running", "false");
  }
  check(
    `a run already under way is refused identically (HTTP ${a.status})`,
    a.status === 409 && same(a, b),
    `node=${short(a)} rust=${short(b)}`
  );
  setBoth("policy_scrape_disabled", "true");
  try {
    [a, b] = await both(JSON.stringify({ phase: "all" }));
  } finally {
    setBoth("policy_scrape_disabled", null);
  }
  check(
    `the kill-switch is refused identically (HTTP ${a.status})`,
    a.status === 409 && same(a, b),
    `node=${short(a)} rust=${short(b)}`
  );
  // Four requests took the minute's four tokens; the fifth is refused.
  [a, b] = await both("{not json");
  const seconds = (r) => Number(r.retryAfter);
  check(
    `the fifth in a minute is refused on both, with a Retry-After (node ${a.retryAfter}, rust ${b.retryAfter})`,
    a.status === 429 &&
      b.status === 429 &&
      a.text === b.text &&
      a.type === b.type &&
      [a, b].every((r) => seconds(r) >= 55 && seconds(r) <= 60),
    `node=${short(a)} rust=${short(b)}`
  );
  return ok;
}
