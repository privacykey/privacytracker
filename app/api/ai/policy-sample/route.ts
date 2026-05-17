export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { recordActivity } from "../../../../lib/activity";
import {
  type AIProvider,
  normalizeAiProvider,
  providerRequiresApiKey,
  resolveDefaultBaseUrl,
} from "../../../../lib/ai-config";
import {
  type AiRuntimeConfig,
  summarizeSamplePrivacyPolicy,
} from "../../../../lib/privacy-policy";
import { getSetting } from "../../../../lib/scheduler";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedJson,
  validateExternalUrl,
} from "../../../../lib/security";

interface SamplePolicyBody {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  provider?: unknown;
}

export async function POST(request: Request) {
  const started = Date.now();

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "ai.policy_sample"),
    limit: 6,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, error: "Rate limit exceeded. Try again shortly." },
      { status: 429 }
    );
  }

  let body: SamplePolicyBody;
  try {
    body = await readBoundedJson<SamplePolicyBody>(request, 16 * 1024);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const provider = normalizeAiProvider(body.provider);
  if (provider === "disabled") {
    return NextResponse.json(
      {
        ok: false,
        error: "Pick an AI provider before running a sample summary.",
      },
      { status: 400 }
    );
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) {
    return NextResponse.json(
      { ok: false, error: "Pick a model before running a sample summary." },
      { status: 400 }
    );
  }
  if (model.length > 200) {
    return NextResponse.json(
      { ok: false, error: "Model ID is too long." },
      { status: 400 }
    );
  }

  const apiKey = resolveSubmittedApiKey(body.apiKey);
  if (providerRequiresApiKey(provider) && !apiKey) {
    return NextResponse.json(
      { ok: false, error: "An API key is required to test this provider." },
      { status: 400 }
    );
  }

  const rawBaseUrl =
    typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const baseUrl = normalizeBaseUrl(
    rawBaseUrl || resolveDefaultBaseUrl(provider),
    provider
  );
  const verdict = validateExternalUrl(baseUrl, {
    maxLength: 512,
    allowPrivateHosts: true,
  });
  if (!verdict.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          verdict.error === "private_host"
            ? "The base URL points at a blocked host (cloud metadata endpoints are always blocked)."
            : `Invalid base URL: ${verdict.detail ?? verdict.error}`,
      },
      { status: 400 }
    );
  }

  const aiConfig: AiRuntimeConfig = {
    provider,
    apiKey,
    baseUrl,
    model,
    label:
      provider === "openai"
        ? "OpenAI"
        : provider === "anthropic"
          ? "Anthropic"
          : "Custom AI endpoint",
  };

  try {
    const result = await summarizeSamplePrivacyPolicy({ aiConfig });
    const durationMs = Date.now() - started;
    recordActivity({
      type: "policy_summary",
      status: "ok",
      appId: null,
      appName: result.sample.appName,
      summary: `Sample policy model test complete (${model})`,
      detail: {
        sample: true,
        provider,
        model,
        mode: result.mode,
        wordCount: result.sample.wordCount,
      },
      startedAt: started,
      endedAt: started + durationMs,
    });
    return NextResponse.json({
      ok: true,
      durationMs,
      provider,
      model,
      mode: result.mode,
      summary: result.summary,
      sample: result.sample,
      phases: result.phases,
    });
  } catch (error) {
    const message = friendlyAiMessage(
      error instanceof Error ? error.message : String(error)
    );
    recordActivity({
      type: "policy_summary",
      status: "error",
      appId: null,
      appName: "Sample Notes",
      summary: `Sample policy model test failed: ${message}`.slice(0, 200),
      detail: {
        sample: true,
        provider,
        model,
        errorMessage: message,
      },
      startedAt: started,
    });
    return NextResponse.json(
      {
        ok: false,
        error: message,
        durationMs: Date.now() - started,
      },
      { status: 502 }
    );
  }
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

function friendlyAiMessage(message: string): string {
  if (/aborted|timeout/i.test(message)) {
    return "Timed out while generating the sample summary.";
  }
  if (/ECONNREFUSED|refused/i.test(message)) {
    return "Connection refused — is the model server running at this URL?";
  }
  if (/ENOTFOUND|getaddrinfo/i.test(message)) {
    return "Hostname not found — check the base URL.";
  }
  if (/certificate|SSL|TLS/i.test(message)) {
    return "TLS/SSL error — check the base URL and certificates.";
  }
  if (/fetch failed/i.test(message)) {
    return "Could not reach the model endpoint.";
  }
  return message;
}
