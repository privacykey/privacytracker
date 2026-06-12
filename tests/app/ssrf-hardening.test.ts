import assert from "node:assert/strict";
import { promises as dnsPromises } from "node:dns";
import test, { mock } from "node:test";
import { postWebhookTestPayload } from "../../lib/notification-webhooks";
import {
  assertUrlSafeToFetch,
  hostResolvesToMetadata,
  safeFetch,
} from "../../lib/security";

interface AiRoute {
  POST: (request: Request) => Promise<Response> | Response;
}

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
  mock.restoreAll();
});

// ─────────────────────────────────────────────
// hostResolvesToMetadata — the resolve-time metadata gate
// ─────────────────────────────────────────────

test("hostResolvesToMetadata flags metadata IPs/hosts but allows public + loopback", async () => {
  // Metadata targets — the one private destination we never permit, even for
  // allowPrivateHosts callers.
  assert.equal(await hostResolvesToMetadata("169.254.169.254"), true);
  assert.equal(await hostResolvesToMetadata("169.254.170.2"), true);
  assert.equal(await hostResolvesToMetadata("metadata.google.internal"), true);
  assert.equal(await hostResolvesToMetadata("fd00:ec2::254"), true);

  // Public + loopback/LAN must NOT be flagged as metadata: allowPrivateHosts
  // legitimately permits loopback (Ollama) — only IMDS-range is special.
  assert.equal(await hostResolvesToMetadata("8.8.8.8"), false);
  assert.equal(await hostResolvesToMetadata("127.0.0.1"), false);
  assert.equal(await hostResolvesToMetadata("192.168.1.50"), false);
});

test("safeFetch blocks a hostname that RESOLVES to metadata even with allowPrivateHosts", async () => {
  // DNS-rebinding: a benign-looking hostname whose A record is IMDS. With
  // allowPrivateHosts the public-resolve check is skipped, but the
  // metadata-resolve check must still fire.
  mock.method(dnsPromises, "lookup", async () => [
    { address: "169.254.169.254", family: 4 },
  ]);

  await assert.rejects(
    () =>
      safeFetch("http://rebind.attacker.example/models", {
        allowPrivateHosts: true,
        resolveAndCheck: true,
      }),
    /cloud-metadata endpoint/
  );
});

test("safeFetch allows a host resolving to loopback when allowPrivateHosts is set", async () => {
  // The companion to the test above: a private (non-metadata) resolution is
  // fine for an allowPrivateHosts caller, so the request proceeds to fetch.
  mock.method(dnsPromises, "lookup", async () => [
    { address: "127.0.0.1", family: 4 },
  ]);
  global.fetch = (async () =>
    new Response("ok", { status: 200 })) as typeof fetch;

  const result = await safeFetch("http://local-ollama.example/models", {
    allowPrivateHosts: true,
    resolveAndCheck: true,
    maxBytes: 64,
  });
  assert.equal(result.response.status, 200);
});

// ─────────────────────────────────────────────
// Finding #2 — webhook deliveries route through safeFetch
// ─────────────────────────────────────────────

test("webhook delivery is rejected when the host does not resolve to a public address", async () => {
  // Force the DNS-rebinding check on (the test harness disables it by default
  // to stay offline). example.invalid is guaranteed NXDOMAIN, so the
  // resolve-time check rejects it — proving webhook POSTs now go through
  // safeFetch's resolver rather than a syntactic-only check + raw fetch.
  const prevSkip =
    process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS;
  process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = "0";
  let fetchCalls = 0;
  global.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return originalFetch(...args);
  }) as typeof fetch;
  try {
    const result = await postWebhookTestPayload(
      "https://example.invalid/webhook",
      "generic"
    );
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /did not resolve to a public address/);
    // Critically: we never issued the outbound POST.
    assert.equal(fetchCalls, 0);
  } finally {
    process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = prevSkip;
  }
});

test("webhook delivery rejects a private/loopback IP literal before any request", async () => {
  let fetchCalls = 0;
  global.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return originalFetch(...args);
  }) as typeof fetch;

  const loopback = await postWebhookTestPayload(
    "http://127.0.0.1/hook",
    "slack"
  );
  assert.equal(loopback.ok, false);

  const metadata = await postWebhookTestPayload(
    "http://169.254.169.254/latest/meta-data",
    "generic"
  );
  assert.equal(metadata.ok, false);

  assert.equal(fetchCalls, 0);
});

test("webhook delivery POSTs the payload body through safeFetch on the happy path", async () => {
  let seenMethod: string | undefined;
  let seenBody: string | undefined;
  global.fetch = (async (_input: unknown, init?: RequestInit) => {
    seenMethod = init?.method;
    seenBody = typeof init?.body === "string" ? init.body : undefined;
    return new Response("", { status: 200 });
  }) as typeof fetch;

  const result = await postWebhookTestPayload(
    "https://hooks.example.com/services/abc",
    "slack"
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(seenMethod, "POST");
  assert.match(seenBody ?? "", /Webhook test from privacytracker/);
});

// ─────────────────────────────────────────────
// Finding #1 — AI test route bounds + never echoes internal bodies
// ─────────────────────────────────────────────

test("AI test route never echoes the remote endpoint's response body", async () => {
  const secret = "X-INTERNAL-BANNER nginx/1.21.0 admin-panel token=abcd1234";
  global.fetch = (async () =>
    new Response(secret, {
      status: 401,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;

  const route = (await import("../../app/api/ai/test/route")) as AiRoute;
  const res = await route.POST(
    new Request("http://127.0.0.1/api/ai/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": "ai-test-noecho",
      },
      body: JSON.stringify({
        provider: "custom",
        baseUrl: "http://192.168.0.40:1234",
      }),
    })
  );

  const body = (await res.json()) as { ok?: boolean; message?: string };
  assert.equal(body.ok, false);
  // Generic, status-derived message — none of the internal body leaks out.
  assert.match(body.message ?? "", /Unauthorized/);
  assert.doesNotMatch(body.message ?? "", /nginx|admin-panel|abcd1234|banner/i);
});

test("AI test route requires the admin token when network-exposed", async () => {
  const prevToken = process.env.AUDITOR_ADMIN_TOKEN;
  const prevExposed = process.env.PRIVACYTRACKER_NETWORK_EXPOSED;
  delete process.env.AUDITOR_ADMIN_TOKEN;
  // Exposure is config-driven now, not inferred from the (spoofable) Host.
  process.env.PRIVACYTRACKER_NETWORK_EXPOSED = "1";
  let fetchCalls = 0;
  global.fetch = (async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const route = (await import("../../app/api/ai/test/route")) as AiRoute;
    const res = await route.POST(
      new Request("https://privacytracker.example/api/ai/test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "privacytracker.example",
          "x-real-ip": "ai-test-nonlocal",
        },
        body: JSON.stringify({
          provider: "custom",
          baseUrl: "http://169.254.169.254/",
        }),
      })
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as { message?: string };
    assert.match(body.message ?? "", /Admin token required/);
    // The SSRF fetch must never have been attempted.
    assert.equal(fetchCalls, 0);
  } finally {
    if (prevToken === undefined) {
      delete process.env.AUDITOR_ADMIN_TOKEN;
    } else {
      process.env.AUDITOR_ADMIN_TOKEN = prevToken;
    }
    if (prevExposed === undefined) {
      delete process.env.PRIVACYTRACKER_NETWORK_EXPOSED;
    } else {
      process.env.PRIVACYTRACKER_NETWORK_EXPOSED = prevExposed;
    }
  }
});

test("AI models route requires the admin token when network-exposed", async () => {
  const prevToken = process.env.AUDITOR_ADMIN_TOKEN;
  const prevExposed = process.env.PRIVACYTRACKER_NETWORK_EXPOSED;
  delete process.env.AUDITOR_ADMIN_TOKEN;
  process.env.PRIVACYTRACKER_NETWORK_EXPOSED = "1";
  let fetchCalls = 0;
  global.fetch = (async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const route = (await import("../../app/api/ai/models/route")) as AiRoute;
    const res = await route.POST(
      new Request("https://privacytracker.example/api/ai/models", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "privacytracker.example",
          "x-real-ip": "ai-models-nonlocal",
        },
        body: JSON.stringify({
          provider: "custom",
          baseUrl: "http://169.254.169.254/",
        }),
      })
    );
    assert.equal(res.status, 401);
    assert.equal(fetchCalls, 0);
  } finally {
    if (prevToken === undefined) {
      delete process.env.AUDITOR_ADMIN_TOKEN;
    } else {
      process.env.AUDITOR_ADMIN_TOKEN = prevToken;
    }
    if (prevExposed === undefined) {
      delete process.env.PRIVACYTRACKER_NETWORK_EXPOSED;
    } else {
      process.env.PRIVACYTRACKER_NETWORK_EXPOSED = prevExposed;
    }
  }
});

// ─────────────────────────────────────────────
// Follow-up — pre-flight guard for the streaming AI inference calls
// ─────────────────────────────────────────────

test("assertUrlSafeToFetch rejects metadata literals and hosts that resolve to metadata", async () => {
  // Syntactic: a metadata IP literal is rejected even with allowPrivateHosts.
  await assert.rejects(
    () =>
      assertUrlSafeToFetch("http://169.254.169.254/v1", {
        allowPrivateHosts: true,
      }),
    /Blocked URL/
  );

  // Resolve-time: a benign-looking hostname that rebinds to IMDS is rejected
  // before the URL is ever returned to the caller's fetch.
  mock.method(dnsPromises, "lookup", async () => [
    { address: "169.254.169.254", family: 4 },
  ]);
  await assert.rejects(
    () =>
      assertUrlSafeToFetch("http://rebind.attacker.example/v1", {
        allowPrivateHosts: true,
        resolveAndCheck: true,
      }),
    /cloud-metadata endpoint/
  );
});

test("assertUrlSafeToFetch allows a loopback resolution under allowPrivateHosts", async () => {
  mock.method(dnsPromises, "lookup", async () => [
    { address: "127.0.0.1", family: 4 },
  ]);
  const url = await assertUrlSafeToFetch("http://ollama.local/v1", {
    allowPrivateHosts: true,
    resolveAndCheck: true,
  });
  assert.equal(url.hostname, "ollama.local");
});

test("assertUrlSafeToFetch requires a public resolution when allowPrivateHosts is off", async () => {
  await assert.rejects(
    () =>
      assertUrlSafeToFetch("https://example.invalid/hook", {
        resolveAndCheck: true,
      }),
    /did not resolve to a public address/
  );
});

test("policy summarization never sends the API key to a base URL that resolves to metadata", async () => {
  // End-to-end on the real inference path: with the base URL's hostname
  // rebound to IMDS, the pre-flight guard must fire before any request leaves
  // the process — so the API key in the headers is never transmitted.
  mock.method(dnsPromises, "lookup", async () => [
    { address: "169.254.169.254", family: 4 },
  ]);
  let fetchCalls = 0;
  global.fetch = (async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const prevSkip =
    process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS;
  process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = "0";

  try {
    const mod = await import("../../lib/privacy-policy");
    await assert.rejects(
      () =>
        mod.summarizeSamplePrivacyPolicy({
          aiConfig: {
            provider: "openai",
            baseUrl: "https://rebind.attacker.example",
            apiKey: "super-secret-key",
            model: "gpt-5.4-mini",
            label: "OpenAI",
          },
        }),
      /cloud-metadata endpoint|Invalid AI endpoint/
    );
    // The decisive assertion: no outbound request, so the key never left.
    assert.equal(fetchCalls, 0);
  } finally {
    process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = prevSkip;
  }
});
