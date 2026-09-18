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
