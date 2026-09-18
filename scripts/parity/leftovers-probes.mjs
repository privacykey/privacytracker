/**
 * The outbound leftovers, live on both servers (Rust core Phase 4,
 * batch 6): the webhook test, the App Store preview and the favicon
 * proxy. Each reaches a third party when it succeeds, which a parity run
 * must not depend on, so what is held live is what both must REFUSE, in
 * the same words: a webhook URL on a private address, a format that is
 * not one, a body that is not JSON; a preview URL off the App Store or
 * not a URL at all; a favicon host that is blank, private or localhost.
 * Every one of these is answered before any fetch. The deliveries and
 * the fetches themselves are held by the leftovers oracle.
 *
 * Runs after the bundle probe and before the backup probe. Nothing here
 * writes.
 */

export async function probeLeftoverRoutes(nodeBase, rustBase, token) {
  let ok = true;
  const check = (claim, pass, detail = "") => {
    console.log(`  ${pass ? "✔" : "✘"} leftovers: ${claim}`);
    if (!pass && detail) {
      console.log(`    ${detail}`);
    }
    ok = pass && ok;
    return pass;
  };
  const send = async (base, method, route, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        origin: base,
        "x-auditor-admin-token": token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body,
    });
    return {
      status: res.status,
      text: await res.text(),
      type: res.headers.get("content-type"),
      cache: res.headers.get("cache-control"),
    };
  };
  const both = (...args) =>
    Promise.all([send(nodeBase, ...args), send(rustBase, ...args)]);
  const short = (r) => JSON.stringify(r).slice(0, 300);
  const same = (a, b) =>
    a.status === b.status && a.text === b.text && a.type === b.type;

  const refusals = [
    // ── the webhook test, before it would post ─────────────────────
    [
      "webhook test refuses a loopback URL identically",
      "POST",
      "/api/notifications/webhook-test",
      JSON.stringify({ url: "http://127.0.0.1:9/hook", format: "slack" }),
      200,
    ],
    [
      "webhook test refuses a metadata host identically",
      "POST",
      "/api/notifications/webhook-test",
      JSON.stringify({
        url: "http://169.254.169.254/latest",
        format: "generic",
      }),
      200,
    ],
    [
      "webhook test refuses a format that is not one identically",
      "POST",
      "/api/notifications/webhook-test",
      JSON.stringify({ url: "https://hooks.example.com/x", format: "pager" }),
      400,
    ],
    [
      "webhook test refuses a body that is not JSON identically",
      "POST",
      "/api/notifications/webhook-test",
      "{not json",
      400,
    ],
    [
      "webhook test refuses a missing url identically",
      "POST",
      "/api/notifications/webhook-test",
      JSON.stringify({ format: "slack" }),
      400,
    ],
    // ── the preview, before it would scrape ────────────────────────
    [
      "preview without a url is refused identically",
      "GET",
      "/api/preview",
      undefined,
      400,
    ],
    [
      "preview of a page off the App Store is refused identically",
      "GET",
      "/api/preview?url=https%3A%2F%2Fexample.com%2Fapp%2Fid1",
      undefined,
      400,
    ],
    [
      "preview of something that is not a URL is refused identically",
      "GET",
      "/api/preview?url=not%20a%20url",
      undefined,
      400,
    ],
    // ── the favicon proxy, before it would fetch ───────────────────
    [
      "favicon without a host is refused identically",
      "GET",
      "/api/favicon",
      undefined,
      400,
    ],
    [
      "favicon for a private address is refused identically",
      "GET",
      "/api/favicon?host=10.0.0.1",
      undefined,
      400,
    ],
    [
      "favicon for localhost is refused identically",
      "GET",
      "/api/favicon?host=localhost",
      undefined,
      400,
    ],
  ];
  for (const [claim, method, route, body, status] of refusals) {
    const [a, b] = await both(method, route, body);
    check(
      `${claim} (HTTP ${a.status})`,
      a.status === status && same(a, b) && a.cache === b.cache,
      `node=${short(a)} rust=${short(b)}`
    );
  }
  return ok;
}
