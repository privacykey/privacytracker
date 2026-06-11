import assert from "node:assert/strict";
import test from "node:test";
import { setSetting } from "../../lib/scheduler";

interface ModelsRoute {
  POST: (request: Request) => Promise<Response> | Response;
}

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test("AI model discovery resolves the saved masked OpenAI key and filters non-text models", async () => {
  setSetting("ai_api_key", "saved-openai-key");

  global.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    assert.equal(
      (init?.headers as Record<string, string>)?.Authorization,
      "Bearer saved-openai-key"
    );
    return new Response(
      JSON.stringify({
        data: [
          { id: "gpt-5.4-mini" },
          { id: "text-embedding-3-small" },
          { id: "gpt-image-2" },
          { id: "o4-mini" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const route = (await import("../../app/api/ai/models/route")) as ModelsRoute;
  const res = await route.POST(
    new Request("http://127.0.0.1/api/ai/models", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": "ai-models-openai",
      },
      body: JSON.stringify({
        provider: "openai",
        apiKey: "__SET__",
        baseUrl: "https://api.openai.com/v1",
      }),
    })
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok?: boolean;
    models?: Array<{ id: string }>;
  };
  assert.equal(body.ok, true);
  assert.deepEqual(
    body.models?.map((model) => model.id),
    ["gpt-5.4-mini", "o4-mini"]
  );
});

test("AI model discovery follows Anthropic model pagination", async () => {
  const requestedUrls: string[] = [];

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requestedUrls.push(url);
    assert.equal(
      (init?.headers as Record<string, string>)?.["x-api-key"],
      "anthropic-key"
    );

    if (!url.includes("after_id=")) {
      return new Response(
        JSON.stringify({
          data: [
            { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
          ],
          has_more: true,
          last_id: "claude-sonnet-4-6",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        data: [
          { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
        ],
        has_more: false,
        last_id: "claude-haiku-4-5-20251001",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const route = (await import("../../app/api/ai/models/route")) as ModelsRoute;
  const res = await route.POST(
    new Request("http://127.0.0.1/api/ai/models", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": "ai-models-anthropic",
      },
      body: JSON.stringify({
        provider: "anthropic",
        apiKey: "anthropic-key",
        baseUrl: "https://api.anthropic.com/v1",
      }),
    })
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok?: boolean;
    models?: Array<{ id: string; label: string; source: string }>;
  };
  assert.equal(body.ok, true);
  assert.deepEqual(body.models, [
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      source: "anthropic",
    },
    {
      id: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5",
      source: "anthropic",
    },
  ]);
  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[0], /limit=1000/);
  assert.match(requestedUrls[1], /after_id=claude-sonnet-4-6/);
});
