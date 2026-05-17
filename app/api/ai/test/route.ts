export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  type AIProvider,
  normalizeAiProvider,
  providerRequiresApiKey,
  resolveDefaultBaseUrl,
} from "../../../../lib/ai-config";
import { getSetting } from "../../../../lib/scheduler";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedJson,
  validateExternalUrl,
} from "../../../../lib/security";

interface TestBody {
  apiKey?: unknown;
  baseUrl?: unknown;
  provider?: unknown;
}

export async function POST(request: Request) {
  const started = Date.now();

  // Tight rate limit — this endpoint makes outbound fetches, so it's a
  // cheap amplifier if left unthrottled.
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "ai.test"),
    limit: 10,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, message: "Rate limit exceeded. Try again shortly." },
      { status: 429 }
    );
  }

  let body: TestBody;
  try {
    body = await readBoundedJson<TestBody>(request, 16 * 1024);
  } catch {
    return NextResponse.json(
      { ok: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const provider = normalizeAiProvider(body.provider);
  const apiKey = resolveSubmittedApiKey(body.apiKey);
  const rawBaseUrl =
    typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";

  if (provider === "disabled") {
    return NextResponse.json({
      ok: false,
      message: "Pick an AI provider before testing the connection.",
    });
  }

  if (providerRequiresApiKey(provider) && !apiKey) {
    return NextResponse.json({
      ok: false,
      message: "An API key is required to test this provider.",
    });
  }

  const baseUrl = normalizeBaseUrl(
    rawBaseUrl || resolveDefaultBaseUrl(provider),
    provider
  );

  // SSRF guard. We permit loopback / RFC-1918 here because the whole point
  // of the `custom` provider is to reach Ollama on localhost or a LAN
  // inference box. Metadata endpoints (IMDS / 169.254.0.0/16 / GCP metadata)
  // stay blocked inside validateExternalUrl even with allowPrivateHosts,
  // which is the only really dangerous SSRF target on a cloud host.
  const verdict = validateExternalUrl(baseUrl, {
    maxLength: 512,
    allowPrivateHosts: true,
  });
  if (!verdict.ok) {
    return NextResponse.json({
      ok: false,
      message:
        verdict.error === "private_host"
          ? "The base URL points at a blocked host (cloud metadata endpoints are always blocked)."
          : `Invalid base URL: ${verdict.detail ?? verdict.error}`,
      latencyMs: Date.now() - started,
    });
  }

  try {
    const result = await testProvider({ provider, baseUrl, apiKey });
    const latencyMs = Date.now() - started;
    return NextResponse.json({ ...result, latencyMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({
      ok: false,
      message: friendlyNetworkMessage(message),
      latencyMs: Date.now() - started,
    });
  }
}

async function testProvider({
  provider,
  baseUrl,
  apiKey,
}: {
  provider: Exclude<AIProvider, "disabled">;
  baseUrl: string;
  apiKey: string;
}): Promise<{
  ok: boolean;
  message: string;
  status?: number;
  modelsCount?: number;
}> {
  if (provider === "anthropic") {
    return pingAnthropic({ baseUrl, apiKey });
  }

  // openai + custom both expose an OpenAI-compatible /models endpoint.
  return pingOpenAiCompatible({ baseUrl, apiKey });
}

async function pingOpenAiCompatible({
  baseUrl,
  apiKey,
}: {
  baseUrl: string;
  apiKey: string;
}): Promise<{
  ok: boolean;
  message: string;
  status?: number;
  modelsCount?: number;
}> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // `redirect: 'error'` so an attacker-controlled custom baseUrl can't
  // 302 us to http://169.254.169.254/ (IMDS) on a cloud-hosted deploy.
  // Legitimate AI providers don't redirect their /models endpoint.
  const res = await fetch(`${baseUrl}/models`, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      message:
        shortBodyMessage(res.status, body) ||
        `Endpoint returned HTTP ${res.status}.`,
    };
  }

  let modelsCount: number | undefined;
  try {
    const payload = (await res.json()) as { data?: unknown; models?: unknown };
    if (Array.isArray(payload?.data)) {
      modelsCount = payload.data.length;
    } else if (Array.isArray(payload?.models)) {
      modelsCount = payload.models.length;
    }
  } catch {
    // Non-JSON response still counts as "reachable".
  }

  return {
    ok: true,
    status: res.status,
    modelsCount,
    message:
      modelsCount === undefined
        ? "Reachable."
        : `Reachable · ${modelsCount} model${modelsCount === 1 ? "" : "s"} listed.`,
  };
}

async function pingAnthropic({
  baseUrl,
  apiKey,
}: {
  baseUrl: string;
  apiKey: string;
}): Promise<{
  ok: boolean;
  message: string;
  status?: number;
  modelsCount?: number;
}> {
  const res = await fetch(`${anthropicApiRoot(baseUrl)}/v1/models?limit=1`, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      message:
        shortBodyMessage(res.status, body) ||
        `Anthropic returned HTTP ${res.status}.`,
    };
  }

  let modelsCount: number | undefined;
  try {
    const payload = (await res.json()) as { data?: unknown };
    if (Array.isArray(payload?.data)) {
      modelsCount = payload.data.length;
    }
  } catch {
    /* noop */
  }

  return {
    ok: true,
    status: res.status,
    modelsCount,
    message:
      modelsCount === undefined
        ? "Reachable."
        : `Reachable · ${modelsCount} model${modelsCount === 1 ? "" : "s"} listed.`,
  };
}

function shortBodyMessage(status: number, body: string): string {
  const cleaned = body.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    if (status === 401) {
      return "Unauthorized — check your API key.";
    }
    if (status === 403) {
      return "Forbidden — API key does not have access to this endpoint.";
    }
    if (status === 404) {
      return "Not found — double-check the base URL.";
    }
    if (status === 429) {
      return "Rate limited — try again shortly.";
    }
    return "";
  }
  const snippet = cleaned.slice(0, 180);
  if (status === 401) {
    return `Unauthorized (${snippet})`;
  }
  if (status === 403) {
    return `Forbidden (${snippet})`;
  }
  return `HTTP ${status}: ${snippet}`;
}

function friendlyNetworkMessage(message: string): string {
  if (/aborted|timeout/i.test(message)) {
    return "Timed out reaching the endpoint.";
  }
  if (/ECONNREFUSED|refused/i.test(message)) {
    return "Connection refused — is the server running at this URL?";
  }
  if (/ENOTFOUND|getaddrinfo/i.test(message)) {
    return "Hostname not found — check the base URL.";
  }
  if (/certificate|SSL|TLS/i.test(message)) {
    return "TLS/SSL error — check the base URL and certificates.";
  }
  if (/fetch failed/i.test(message)) {
    return "Could not reach the endpoint.";
  }
  return message;
}

function resolveSubmittedApiKey(raw: unknown): string {
  const submitted = typeof raw === "string" ? raw.trim() : "";
  if (submitted && submitted !== "__SET__") {
    return submitted;
  }
  if (submitted === "__SET__") {
    return getSetting("ai_api_key", "").trim();
  }
  return "";
}

function anthropicApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
}

function normalizeBaseUrl(
  value: string,
  provider: Exclude<AIProvider, "disabled">
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const defaultProtocol = provider === "custom" ? "http" : "https";
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `${defaultProtocol}://${trimmed}`;
  let normalized = withProtocol.replace(/\/+$/, "");

  if (
    (provider === "custom" || provider === "openai") &&
    shouldAppendOpenAiPath(normalized)
  ) {
    normalized = `${normalized}/v1`;
  }

  return normalized;
}

function shouldAppendOpenAiPath(baseUrl: string): boolean {
  if (/\/v1$/i.test(baseUrl)) {
    return false;
  }

  try {
    const parsed = new URL(baseUrl);
    return parsed.pathname === "/" || parsed.pathname === "";
  } catch {
    return false;
  }
}
