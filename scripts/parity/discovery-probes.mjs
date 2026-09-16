/** Real HTTP gate for stored reads, validation and comparison rate limiting.
 * Apple success/failure bodies are pinned separately by discovery-cases.json;
 * no parity run depends on the contents or availability of a live Apple feed.
 */
import {
  DISCOVERY_EMPTY as EMPTY,
  DISCOVERY_APP as ID,
} from "./discovery-fixture.mjs";

export async function probeDiscoveryReads(nodeBase, rustBase, token) {
  let ok = true;
  const read = async (base, url) => {
    const r = await fetch(`${base}${url}`, {
      headers: { "x-auditor-admin-token": token },
    });
    return {
      status: r.status,
      body: await r.text(),
      type: r.headers.get("content-type"),
      retry: r.headers.get("retry-after"),
    };
  };
  const check = async (name, url, status, predicate) => {
    const [a, b] = await Promise.all([
      read(nodeBase, url),
      read(rustBase, url),
    ]);
    let pass = false;
    try {
      pass =
        a.status === status &&
        JSON.stringify(a) === JSON.stringify(b) &&
        predicate(JSON.parse(a.body));
    } catch {}
    console.log(`  ${pass ? "✔" : "✘"} discovery: ${name}`);
    if (!pass) {
      console.log(JSON.stringify({ a, b }));
    }
    ok = pass && ok;
  };
  await check(
    "device scope includes counts and stated ownership",
    "/api/device-scope",
    200,
    (v) =>
      v.scope.v === 1 &&
      v.devices.some(
        (d) =>
          d.ownerLabel === "Mum" &&
          d.ownerAudience === "loved_one" &&
          d.appCount > 0
      )
  );
  await check(
    "populated library compared with empty labels",
    `/api/compare?a=id:${ID}&b=id:${EMPTY}`,
    200,
    (v) =>
      v.a.privacyTypes[0].categories[0].identifier === "CONTACT_INFO" &&
      v.a.accessibilityFeatures.length === 1 &&
      v.b.privacyTypes.length === 0 &&
      v.b.hasPrivacyDetails === null
  );
  await check("missing specs", "/api/compare", 400, (v) =>
    v.error.includes("required")
  );
  await check(
    "missing library row",
    `/api/compare?a=id:missing&b=id:${ID}`,
    500,
    (v) => v.error === "App not found: missing"
  );
  await check(
    "UTF-16 invalid spec",
    `/api/compare?a=${encodeURIComponent(`${"a".repeat(39)}😀tail`)}&b=id:${ID}`,
    500,
    (v) => v.error.endsWith("\ud83d")
  );
  await check(
    "private preview rejected before HTTP",
    `/api/compare?a=${encodeURIComponent("url:http://127.0.0.1/id1")}&b=id:${ID}`,
    500,
    (v) => v.error === "Rejected URL (private_host)"
  );
  await check(
    "stored candidates default to one",
    `/api/related-apps?sourceAppId=${ID}&mode=may_also_like`,
    200,
    (v) =>
      v.candidates.length === 1 &&
      v.candidates[0].appleId === "001" &&
      !("reason" in v)
  );
  await check(
    "fractional stored limit truncates and keeps order",
    `/api/related-apps?sourceAppId=${ID}&mode=may_also_like&limit=2.9`,
    200,
    (v) => v.candidates.map((c) => c.appleId).join(",") === "001,003"
  );
  await check(
    "stored absence has a reason",
    `/api/related-apps?sourceAppId=${EMPTY}&mode=may_also_like`,
    200,
    (v) => v.reason === "not_scraped_yet"
  );
  await check(
    "missing genre on local id avoids Apple",
    `/api/related-apps?sourceAppId=${EMPTY}`,
    200,
    (v) => v.genreId === null && v.candidates.length === 0 && !("reason" in v)
  );
  await check(
    "invalid source",
    "/api/related-apps?sourceAppId=bad%20id",
    400,
    (v) => v.error.includes("valid app id")
  );
  await check(
    "missing source",
    "/api/related-apps?sourceAppId=absent",
    404,
    (v) => v.error === "Source app not found."
  );
  // Exhaust only this route's bucket after the functional checks. The route
  // validates specs before touching the network, including denied requests.
  const url = `/api/compare?a=url:invalid&b=id:${ID}`;
  for (let i = 0; i < 31; i++) {
    await Promise.all([read(nodeBase, url), read(rustBase, url)]);
  }
  const values = await Promise.all([read(nodeBase, url), read(rustBase, url)]);
  const limited = values.every(
    (r) =>
      r.status === 429 &&
      Number(r.retry) > 0 &&
      Number(r.retry) <= 60 &&
      r.body ===
        '{"error":"Rate limit exceeded for /api/compare. Try again shortly."}'
  );
  console.log(
    `  ${limited ? "✔" : "✘"} discovery: comparison limiter and Retry-After`
  );
  return ok && limited;
}
