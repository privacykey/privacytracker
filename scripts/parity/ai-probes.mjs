/**
 * The AI routes, live on both servers (Rust core Phase 5, batch 3b).
 *
 * A parity run must never reach a real AI provider, so this probe runs one
 * of its own: a loopback HTTP server that answers the OpenAI-compatible
 * model list, Ollama's tag list and a streamed chat completion with a
 * fixed summary. Loopback is allowed for AI endpoints on both servers,
 * because a local model is what the custom provider is for. Each request
 * goes to Node and then to the core, one at a time, so the fake's log
 * says which server asked for what:
 *
 * - the connection test and the model list for a custom, an OpenAI and an
 *   Anthropic base URL, and the Ollama fallback when the OpenAI-compatible
 *   list is missing;
 * - the sample summary, with the prompt each server sent compared once
 *   the nonce marking each untrusted block, its one random part, is masked;
 * - regenerate's summarise phase for the fixture's AI app, answered whole
 *   and as an NDJSON phase stream, which on the core is the spawned run.
 *
 * Only clocks are masked: `at`, `ms` and every `…At` and `…Ms` number.
 * Everything else must match byte for byte, the outgoing requests
 * included (method, path, and the headers the code sets itself).
 *
 * The bundle probe, which runs earlier, imports each server's audit bundle
 * into both, and an import marks the AI app's analysis as an excerpt that
 * neither server will summarise; so before regenerating, this puts the
 * row back as the policy fixture wrote it, on both, while they run.
 *
 * It writes (activity rows, the AI app's analysis, the AI settings, which
 * it clears again) and runs before the backup probe, which ends by
 * restoring one backup into both servers.
 */
import http from "node:http";
import { POLICY_APP_AI, resetPolicyAiApp } from "./policy-fixture.mjs";

const LENS_KEYS = [
  "collection_scope",
  "product_use",
  "ads_marketing",
  "third_party_sharing",
  "tracking_analytics",
  "user_controls",
  "data_retention",
  "children_minors",
];
const SUMMARY = {
  overview:
    "The app collects an email address and device identifiers and shares them with its hosting providers.",
  highlights: [
    "Collects email addresses.",
    "Collects precise device identifiers.",
    "Shares data with hosting providers.",
  ],
  lenses: LENS_KEYS.map((key, i) => ({
    key,
    rating: ["favorable", "mixed", "concerning", "unclear"][i % 4],
    summary: `Lens ${i + 1} is grounded in the policy text.`,
  })),
};
const LIST = {
  object: "list",
  data: [
    "fake-model-a",
    "fake-model-b",
    "gpt-parity-mini",
    "text-embedding-parity",
    "fake-model-a",
  ].map((id) => ({ id, object: "model", owned_by: "parity" })),
};
const TAGS = {
  models: [
    { name: "fake-model-a" },
    { name: "fake-model-a" },
    { name: "fake-model-c" },
  ],
};
const SENT_HEADERS = [
  "content-type",
  "accept",
  "authorization",
  "x-api-key",
  "anthropic-version",
];

/** An OpenAI-compatible event stream carrying `content` in three deltas. */
function eventStream(content) {
  const frame = (delta) =>
    `data: ${JSON.stringify({ id: "chatcmpl-parity", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  const step = Math.ceil(content.length / 3);
  const frames = [frame({ role: "assistant", content: "" })];
  for (let i = 0; i < content.length; i += step) {
    frames.push(frame({ content: content.slice(i, i + step) }));
  }
  frames.push("data: [DONE]\n\n");
  return frames;
}

async function startFakeProvider() {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = Object.fromEntries(
        SENT_HEADERS.filter((name) => req.headers[name] !== undefined).map(
          (name) => [name, req.headers[name]]
        )
      );
      log.push({ method: req.method, url: req.url, headers, body });
      const path = req.url.split("?")[0];
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method === "GET" && path === "/v1/models") {
        return json(200, LIST);
      }
      if (req.method === "GET" && path === "/bare/api/tags") {
        return json(200, TAGS);
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // One write per frame, so the stream arrives in pieces.
        for (const frame of eventStream(JSON.stringify(SUMMARY))) {
          res.write(frame);
        }
        return res.end();
      }
      return json(404, { error: "not found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Clocks, masked in the text itself so nothing else is re-serialised. */
const maskClocks = (text) =>
  text.replace(/(\\?")((?:[A-Za-z]*(?:At|Ms))|at|ms)(\\?"):-?\d+/g, "$1$2$3:0");
/** The nonce each untrusted prompt block is marked with. */
const maskNonces = (text) =>
  text.replace(/(UNTRUSTED_[A-Z_]+:)[A-Za-z0-9_-]{20}/g, "$1<nonce>");

export async function probeAiRoutes(
  nodeBase,
  rustBase,
  token,
  nodeData,
  rustData
) {
  let ok = true;
  const check = (claim, pass, detail = "") => {
    console.log(`  ${pass ? "✔" : "✘"} ai: ${claim}`);
    if (!pass && detail) {
      console.log(`    ${detail}`);
    }
    ok = pass && ok;
    return pass;
  };
  const fake = await startFakeProvider();
  const send = async (base, route, body) => {
    const res = await fetch(`${base}${route}`, {
      method: "POST",
      headers: {
        origin: base,
        "x-auditor-admin-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      type: res.headers.get("content-type"),
      cacheControl: res.headers.get("cache-control"),
      text: await res.text(),
    };
  };
  // Node first, then the core, each with the requests it made.
  const both = async (route, body) => {
    const before = fake.log.length;
    const node = await send(nodeBase, route, body);
    const middle = fake.log.length;
    const rust = await send(rustBase, route, body);
    const calls = (from, to) =>
      JSON.stringify(
        fake.log
          .slice(from, to)
          .map((call) => ({ ...call, body: maskNonces(call.body) }))
      );
    return {
      node,
      rust,
      nodeCalls: calls(before, middle),
      rustCalls: calls(middle, fake.log.length),
    };
  };
  const short = (value) => String(value).slice(0, 400);
  const same = (r) =>
    r.node.status === r.rust.status &&
    r.node.type === r.rust.type &&
    r.node.cacheControl === r.rust.cacheControl &&
    maskClocks(r.node.text) === maskClocks(r.rust.text);
  const holds = (claim, r, extra = true) => {
    check(
      `${claim} (HTTP ${r.node.status})`,
      same(r) && extra,
      `node=${short(JSON.stringify(r.node))} rust=${short(JSON.stringify(r.rust))}`
    );
    check(
      `${claim}: both servers asked the provider the same thing`,
      r.nodeCalls === r.rustCalls,
      `node=${short(r.nodeCalls)} rust=${short(r.rustCalls)}`
    );
  };
  const settings = (body) =>
    Promise.all([
      send(nodeBase, "/api/settings", body),
      send(rustBase, "/api/settings", body),
    ]);

  try {
    const custom = { provider: "custom", baseUrl: fake.base };
    let r = await both("/api/ai/test", custom);
    holds(
      "the connection test reaches a local model",
      r,
      r.node.status === 200
    );
    r = await both("/api/ai/test", {
      provider: "anthropic",
      apiKey: "sk-ant-parity",
      baseUrl: fake.base,
    });
    holds("the connection test speaks Anthropic's list", r);
    r = await both("/api/ai/models", custom);
    holds(
      "the model list of a local model",
      r,
      r.node.text.includes("fake-model-b")
    );
    r = await both("/api/ai/models", {
      provider: "openai",
      apiKey: "sk-parity",
      baseUrl: fake.base,
    });
    holds(
      "the model list keeps OpenAI's chat models",
      r,
      r.node.text.includes("gpt-parity-mini") &&
        !r.node.text.includes("text-embedding-parity")
    );
    r = await both("/api/ai/models", {
      provider: "custom",
      baseUrl: `${fake.base}/bare`,
    });
    holds(
      "the model list falls back to Ollama's tags",
      r,
      r.node.text.includes("fake-model-c")
    );

    r = await both("/api/ai/policy-sample", {
      ...custom,
      model: "fake-model-a",
    });
    holds(
      "the sample summary, from the same prompt",
      r,
      r.node.status === 200 && r.nodeCalls.includes("UNTRUSTED_")
    );

    const [a, b] = await settings({
      ai_provider: "custom",
      ai_base_url: fake.base,
      ai_model: "fake-model-a",
    });
    check(
      "both servers point at the fake provider",
      a.status === 200 && b.status === 200,
      `node=${short(a.text)} rust=${short(b.text)}`
    );
    resetPolicyAiApp(nodeData, rustData);
    const asked = (calls) => calls.includes('"url":"/v1/chat/completions"');
    r = await both("/api/policy/regenerate", {
      appId: POLICY_APP_AI,
      phase: "summarise",
    });
    holds(
      "regenerate summarises the stored policy",
      r,
      r.node.status === 200 &&
        r.node.text.includes('"status":"ready"') &&
        asked(r.nodeCalls)
    );
    r = await both("/api/policy/regenerate", {
      appId: POLICY_APP_AI,
      phase: "summarise",
      stream: true,
    });
    const lines = r.node.text.split("\n").filter(Boolean);
    holds(
      "regenerate streams the run's phases, then the analysis",
      r,
      r.node.type === "application/x-ndjson; charset=utf-8" &&
        lines.length > 2 &&
        lines.at(-1).startsWith('{"type":"done"') &&
        asked(r.nodeCalls)
    );
    r = await both("/api/policy/regenerate", { appId: "not-an-id" });
    holds(
      "regenerate refuses an id that is not digits",
      r,
      r.node.status === 400
    );
    r = await both("/api/policy/regenerate", { appId: "42" });
    holds(
      "regenerate refuses an app it does not know",
      r,
      r.node.status === 404
    );
  } finally {
    await settings({ ai_provider: "disabled", ai_base_url: "", ai_model: "" });
    await fake.close();
  }
  return ok;
}
