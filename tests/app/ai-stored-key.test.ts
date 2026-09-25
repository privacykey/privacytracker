/**
 * The `__SET__` placeholder Settings submits for a saved AI key only
 * resolves to that key when the request targets the provider and base URL
 * the key was saved for. Anywhere else the route answers 400 and makes no
 * outbound request at all.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubmittedApiKey } from "../../lib/ai-submitted-key";
import { setSetting } from "../../lib/scheduler";
import { resetTestDb } from "../helpers/test-db";

interface Route {
  POST(request: Request): Promise<Response>;
}

const originalFetch = global.fetch;
let outbound: { url: string; headers: Record<string, string> }[] = [];

test.beforeEach(() => {
  resetTestDb();
  outbound = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    outbound.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

test.afterEach(() => {
  global.fetch = originalFetch;
  resetTestDb();
});

function saveOpenAiKey() {
  setSetting("ai_provider", "openai");
  setSetting("ai_api_key", "sk-saved");
}

let ip = 0;
async function post(path: string, body: Record<string, unknown>) {
  ip += 1;
  const route = (await import(`../../app/api/ai/${path}/route`)) as Route;
  return route.POST(
    new Request(`http://127.0.0.1/api/ai/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": `ai-stored-key-${ip}`,
      },
      body: JSON.stringify(body),
    })
  );
}

const REFUSED = /only sent to the saved provider and base URL/;

test("each AI route refuses the saved key for another base URL and fetches nothing", async () => {
  saveOpenAiKey();
  for (const [path, field] of [
    ["test", "message"],
    ["models", "message"],
    ["policy-sample", "error"],
  ] as const) {
    const res = await post(path, {
      provider: "openai",
      apiKey: "__SET__",
      baseUrl: "https://collector.example/v1",
      model: "gpt-4o",
    });
    assert.equal(res.status, 400, path);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.match(String(body[field]), REFUSED);
  }
  assert.deepEqual(outbound, []);
});

test("the saved key is refused for another provider", async () => {
  saveOpenAiKey();
  const res = await post("test", { provider: "anthropic", apiKey: "__SET__" });
  assert.equal(res.status, 400);
  assert.deepEqual(outbound, []);
});

test("the saved key still reaches the saved endpoint, however it is spelled", async () => {
  saveOpenAiKey();
  const res = await post("test", {
    provider: "openai",
    apiKey: "__SET__",
    baseUrl: "HTTPS://API.OPENAI.COM:443/v1/",
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].headers.Authorization, "Bearer sk-saved");
});

test("a typed key goes wherever the caller points it", async () => {
  saveOpenAiKey();
  const res = await post("test", {
    provider: "openai",
    apiKey: "sk-typed",
    baseUrl: "https://other.example/v1",
  });
  assert.equal(res.status, 200);
  assert.equal(outbound[0].url, "https://other.example/v1/models");
  assert.equal(outbound[0].headers.Authorization, "Bearer sk-typed");
});

test("resolveSubmittedApiKey pins the saved key to its provider and base URL", () => {
  setSetting("ai_provider", "ollama");
  setSetting("ai_base_url", "http://127.0.0.1:11434/");
  setSetting("ai_api_key", " sk-local ");
  assert.deepEqual(
    resolveSubmittedApiKey("__SET__", "custom", "http://127.0.0.1:11434/v1"),
    { ok: true, apiKey: "sk-local" }
  );
  assert.equal(
    resolveSubmittedApiKey("__SET__", "custom", "http://127.0.0.1:11435/v1").ok,
    false
  );
  assert.equal(
    resolveSubmittedApiKey("__SET__", "openai", "http://127.0.0.1:11434/v1").ok,
    false
  );
  // Nothing saved: the placeholder stands for no key, as before.
  setSetting("ai_api_key", "");
  assert.deepEqual(
    resolveSubmittedApiKey("__SET__", "openai", "https://x.example/v1"),
    { ok: true, apiKey: "" }
  );
});
