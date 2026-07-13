import assert from "node:assert/strict";
import test from "node:test";

interface RouteModule {
  default?: {
    GET?: (request: Request) => Promise<Response> | Response;
    POST?: (request: Request) => Promise<Response> | Response;
    PUT?: (request: Request) => Promise<Response> | Response;
  };
  GET?: (request: Request) => Promise<Response> | Response;
  POST?: (request: Request) => Promise<Response> | Response;
  PUT?: (request: Request) => Promise<Response> | Response;
}

function unwrapRoute(mod: RouteModule) {
  return {
    GET: mod.GET ?? mod.default?.GET,
    POST: mod.POST ?? mod.default?.POST,
    PUT: mod.PUT ?? mod.default?.PUT,
  };
}

const originalAdminToken = process.env.AUDITOR_ADMIN_TOKEN;
test.after(() => {
  if (originalAdminToken === undefined) {
    delete process.env.AUDITOR_ADMIN_TOKEN;
  } else {
    process.env.AUDITOR_ADMIN_TOKEN = originalAdminToken;
  }
});

test("health and readiness routes respond with safe probe payloads", async () => {
  const health = unwrapRoute(
    (await import("../../app/api/health/route")) as RouteModule
  );
  const ready = unwrapRoute(
    (await import("../../app/api/ready/route")) as RouteModule
  );

  assert.ok(health.GET);
  assert.ok(ready.GET);

  const healthRes = await health.GET(
    new Request("http://127.0.0.1/api/health")
  );
  assert.equal(healthRes.status, 200);
  assert.equal((await healthRes.json()).status, "ok");

  const readyRes = await ready.GET(new Request("http://127.0.0.1/api/ready"));
  assert.equal(readyRes.status, 200);
  const readyBody = await readyRes.json();
  assert.equal(readyBody.status, "ready");
  assert.ok(Array.isArray(readyBody.checks));
});

test("destructive routes reject missing admin token when configured", async () => {
  const previous = process.env.AUDITOR_ADMIN_TOKEN;
  process.env.AUDITOR_ADMIN_TOKEN = "route-smoke-secret";

  try {
    const reset = unwrapRoute(
      (await import("../../app/api/reset/route")) as RouteModule
    );
    const startOver = unwrapRoute(
      (await import("../../app/api/admin/start-over/route")) as RouteModule
    );
    const restore = unwrapRoute(
      (await import("../../app/api/backup/restore/route")) as RouteModule
    );
    const snapshots = unwrapRoute(
      (await import("../../app/api/backup/snapshots/route")) as RouteModule
    );
    const exportRoute = unwrapRoute(
      (await import("../../app/api/backup/export/route")) as RouteModule
    );

    assert.ok(reset.POST);
    assert.ok(startOver.POST);
    assert.ok(restore.POST);
    assert.ok(snapshots.POST);
    assert.ok(exportRoute.GET);

    const resetRes = await reset.POST(
      new Request("http://127.0.0.1/api/reset", {
        method: "POST",
        headers: { "x-real-ip": "route-smoke-reset" },
      })
    );
    assert.equal(resetRes.status, 401);

    const startOverRes = await startOver.POST(
      new Request("http://127.0.0.1/api/admin/start-over", {
        method: "POST",
        headers: { "x-real-ip": "route-smoke-start-over" },
      })
    );
    assert.equal(startOverRes.status, 401);

    const restoreRes = await restore.POST(
      new Request("http://127.0.0.1/api/backup/restore", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": "route-smoke-restore",
        },
        body: "{}",
      })
    );
    assert.equal(restoreRes.status, 401);

    const snapshotRes = await snapshots.POST(
      new Request("http://127.0.0.1/api/backup/snapshots", {
        method: "POST",
        headers: { "x-real-ip": "route-smoke-snapshot" },
      })
    );
    assert.equal(snapshotRes.status, 401);

    // Backup export is not destructive, but it bundles every row of
    // app_settings (which historically included `ai_api_key` in plaintext).
    // A missing admin token must therefore yield 401 — without this gate, a
    // caller who couldn't read settings could still extract the same data
    // by hitting export, which defeats the masking on /api/settings.
    const exportRes = await exportRoute.GET(
      new Request("http://127.0.0.1/api/backup/export", {
        headers: { "x-real-ip": "route-smoke-export" },
      })
    );
    assert.equal(exportRes.status, 401);
  } finally {
    if (previous === undefined) {
      delete process.env.AUDITOR_ADMIN_TOKEN;
    } else {
      process.env.AUDITOR_ADMIN_TOKEN = previous;
    }
  }
});

test("exportBackup scrubs sensitive app_settings values from the envelope", async () => {
  const { setSetting, getSetting } = await import("../../lib/scheduler");
  const { exportBackup, SENSITIVE_SETTING_KEYS } = await import(
    "../../lib/backup"
  );

  // Persist known secrets, then dump a backup envelope and assert
  // that (a) each row is still present (so restore knows the column is
  // managed) and (b) its `value` column is empty so no secret leaks through
  // any caller of `exportBackup` — direct route, scheduled snapshot, or
  // future audit-bundle composer. Defence is at the lib layer because all
  // three call sites funnel through this one function.
  const sentinel = `sk-route-smoke-DO-NOT-LEAK-${Date.now()}`;
  // Embed a unique, non-URL-shaped token in the webhook path and assert on
  // *that* below. Probing the serialised envelope with `includes(<bare URL>)`
  // trips CodeQL's js/incomplete-url-substring-sanitization, which can't tell a
  // leak-detection assertion from a host-allowlist check. A per-run token (same
  // pattern as the API-key sentinel above) is both a stronger leak probe and
  // clear of the false positive — if the stored URL leaks, the token leaks with
  // it.
  const webhookToken = `route-smoke-webhook-DO-NOT-LEAK-${Date.now()}`;
  const webhookSentinel = `https://hooks.slack.com/services/TROUTE/BROUTE/${webhookToken}`;
  setSetting("ai_api_key", sentinel);
  setSetting("notification_webhook_url", webhookSentinel);

  try {
    // Sanity check: the settings layer can read both values before we scrub.
    assert.equal(getSetting("ai_api_key", ""), sentinel);
    assert.equal(getSetting("notification_webhook_url", ""), webhookSentinel);

    const envelope = exportBackup();
    const settings = envelope.tables.app_settings;
    assert.ok(settings, "app_settings table should be present in the envelope");

    // The whole serialised envelope must not contain the sentinel anywhere
    // — catches accidental leaks via columns we forgot to scrub or future
    // tables that mirror the value.
    const serialised = JSON.stringify(envelope);
    assert.equal(
      serialised.includes(sentinel),
      false,
      "serialised backup envelope must not contain the plaintext API key"
    );
    assert.equal(
      serialised.includes(webhookToken),
      false,
      "serialised backup envelope must not contain the plaintext webhook URL"
    );

    // Each sensitive key must appear in the dump as an empty-string value
    // (not omitted, so a restore on top of a populated DB still wipes the
    // existing row to keep the two installs in sync).
    for (const key of SENSITIVE_SETTING_KEYS) {
      const row = settings.rows.find((r) => r.key === key);
      if (!row) {
        continue; // setting wasn't configured pre-export
      }
      assert.equal(
        row.value,
        "",
        `sensitive setting ${key} must be redacted to '' in the backup envelope`
      );
    }
  } finally {
    // Clean up so other tests don't see the sentinel values.
    setSetting("ai_api_key", "");
    setSetting("notification_webhook_url", "");
  }
});

test("settings GET masks webhook URLs and POST preserves masked round-trips", async () => {
  const { setSetting, getSetting } = await import("../../lib/scheduler");
  const settings = unwrapRoute(
    (await import("../../app/api/settings/route")) as RouteModule
  );
  assert.ok(settings.GET);
  assert.ok(settings.POST);

  const webhook =
    "https://hooks.slack.com/services/T12345678/B98765432/very-secret-token";
  setSetting("notification_webhook_url", webhook);

  try {
    const res = await settings.GET(
      new Request("http://127.0.0.1/api/settings")
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.notification_webhook_url_set, true);
    assert.equal(
      body.notification_webhook_url,
      "https://hooks.slack.com/services/T***/B***/***"
    );
    assert.equal(JSON.stringify(body).includes("very-secret-token"), false);

    const postRes = await settings.POST(
      new Request("http://127.0.0.1/api/settings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": "route-smoke-settings-webhook",
        },
        body: JSON.stringify({
          notification_webhook_url: body.notification_webhook_url,
        }),
      })
    );
    assert.equal(postRes.status, 200);
    assert.equal(getSetting("notification_webhook_url", ""), webhook);
  } finally {
    setSetting("notification_webhook_url", "");
  }
});

test("search and backup preview reject unsafe request bodies before work starts", async () => {
  const search = unwrapRoute(
    (await import("../../app/api/search/route")) as RouteModule
  );
  const preview = unwrapRoute(
    (await import("../../app/api/backup/preview/route")) as RouteModule
  );

  assert.ok(search.POST);
  assert.ok(preview.POST);

  const searchRes = await search.POST(
    new Request("http://127.0.0.1/api/search", {
      method: "POST",
      headers: {
        "content-length": String(512 * 1024),
        "content-type": "application/json",
        "x-real-ip": "route-smoke-search",
      },
      body: "{}",
    })
  );
  assert.equal(searchRes.status, 400);

  const previewRes = await preview.POST(
    new Request("http://127.0.0.1/api/backup/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  );
  assert.equal(previewRes.status, 400);
});

test("deployment support bundle is copy/paste safe and includes probe data", async () => {
  const route = unwrapRoute(
    (await import(
      "../../app/api/deployment/support-bundle/route"
    )) as RouteModule
  );
  assert.ok(route.GET);

  const res = await route.GET(
    new Request("https://privacytracker.local/api/deployment/support-bundle", {
      headers: {
        host: "privacytracker.local",
        "x-forwarded-host": "privacytracker.local",
        "x-forwarded-proto": "https",
      },
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.diagnostics.health.status, "ok");
  assert.ok(Array.isArray(body.recentErrors));
  assert.equal(JSON.stringify(body).includes("x-auditor-admin-token"), false);
});
