export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import {
  normalizeAiProvider,
  providerRequiresApiKey,
  resolveDefaultBaseUrl,
  type AIProvider,
} from '../../../../lib/ai-config';
import { getSetting } from '../../../../lib/scheduler';
import {
  validateExternalUrl,
  readBoundedJson,
  checkRateLimit,
  rateLimitKeyForRequest,
} from '../../../../lib/security';

interface ModelsBody {
  provider?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
}

interface DiscoveredModel {
  id: string;
  label: string;
  source: 'openai-compat' | 'ollama' | 'anthropic';
}

export async function POST(request: Request) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, 'ai.models'),
    limit: 10,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ ok: false, message: 'Rate limit exceeded.' }, { status: 429 });
  }

  let body: ModelsBody;
  try {
    body = await readBoundedJson<ModelsBody>(request, 16 * 1024);
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON body.' }, { status: 400 });
  }

  const provider = normalizeAiProvider(body.provider);
  const apiKey = resolveSubmittedApiKey(body.apiKey);
  const rawBaseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';

  if (provider === 'disabled') {
    return NextResponse.json({ ok: false, message: 'Pick an AI provider first.' });
  }

  if (providerRequiresApiKey(provider) && !apiKey) {
    return NextResponse.json({
      ok: false,
      message: 'API key required for this provider.',
    });
  }

  const baseUrl = normalizeBaseUrl(rawBaseUrl || resolveDefaultBaseUrl(provider), provider);
  if (!baseUrl) {
    return NextResponse.json({ ok: false, message: 'Base URL is empty.' });
  }

  // Block SSRF via the user-supplied base URL. Loopback / RFC-1918 is
  // permitted because Ollama and similar self-hosted inference servers are
  // the canonical `custom` provider target. Cloud metadata endpoints remain
  // blocked inside validateExternalUrl even with allowPrivateHosts.
  const verdict = validateExternalUrl(baseUrl, {
    maxLength: 512,
    allowPrivateHosts: true,
  });
  if (!verdict.ok) {
    return NextResponse.json({
      ok: false,
      message: verdict.error === 'private_host'
        ? 'The base URL points at a blocked host (cloud metadata endpoints are always blocked).'
        : `Invalid base URL: ${verdict.detail ?? verdict.error}`,
    });
  }

  try {
    const models = await discoverModels({ provider, baseUrl, apiKey });
    return NextResponse.json({ ok: true, models });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({
      ok: false,
      message: friendlyNetworkMessage(message),
    });
  }
}

async function discoverModels({
  provider,
  baseUrl,
  apiKey,
}: {
  provider: Exclude<AIProvider, 'disabled'>;
  baseUrl: string;
  apiKey: string;
}): Promise<DiscoveredModel[]> {
  if (provider === 'anthropic') {
    return fetchAnthropicModels({ baseUrl, apiKey });
  }

  if (provider === 'openai') {
    return fetchOpenAiCompatibleModels({ baseUrl, apiKey, provider });
  }

  // custom: try OpenAI-compatible /models first; if that fails or is empty,
  // fall back to Ollama's native /api/tags. Ollama users often run the server
  // on the root (http://localhost:11434) without /v1.
  const primary = await fetchOpenAiCompatibleModels({ baseUrl, apiKey, provider }).catch(() => [] as DiscoveredModel[]);
  if (primary.length > 0) return primary;

  const fallback = await fetchOllamaTags({ baseUrl }).catch(() => [] as DiscoveredModel[]);
  return fallback;
}

async function fetchOpenAiCompatibleModels({
  baseUrl,
  apiKey,
  provider,
}: {
  baseUrl: string;
  apiKey: string;
  provider: Exclude<AIProvider, 'disabled'>;
}): Promise<DiscoveredModel[]> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const payload = (await res.json()) as { data?: Array<{ id?: string }> };
  if (!Array.isArray(payload?.data)) return [];

  const ids = payload.data
    .map(item => (typeof item?.id === 'string' ? item.id.trim() : ''))
    .filter(id => Boolean(id) && (provider !== 'openai' || isLikelyOpenAiTextModel(id)));

  // De-dupe while preserving order.
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id, source: 'openai-compat' });
  }
  return models;
}

async function fetchOllamaTags({ baseUrl }: { baseUrl: string }): Promise<DiscoveredModel[]> {
  // Ollama's /api/tags is on the server root, not under /v1.
  const root = baseUrl.replace(/\/v1\/?$/i, '');
  const res = await fetch(`${root}/api/tags`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const payload = (await res.json()) as { models?: Array<{ name?: string }> };
  if (!Array.isArray(payload?.models)) return [];

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const item of payload.models) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    models.push({ id: name, label: name, source: 'ollama' });
  }
  return models;
}

async function fetchAnthropicModels({
  baseUrl,
  apiKey,
}: {
  baseUrl: string;
  apiKey: string;
}): Promise<DiscoveredModel[]> {
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  let afterId = '';

  for (let page = 0; page < 5; page += 1) {
    const url = new URL(`${anthropicApiRoot(baseUrl)}/v1/models`);
    url.searchParams.set('limit', '1000');
    if (afterId) url.searchParams.set('after_id', afterId);

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = (await res.json()) as {
      data?: Array<{ id?: string; display_name?: string }>;
      has_more?: boolean;
      last_id?: string | null;
    };
    if (!Array.isArray(payload?.data)) return models;

    for (const item of payload.data) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label = typeof item?.display_name === 'string' && item.display_name.trim()
        ? item.display_name.trim()
        : id;
      models.push({ id, label, source: 'anthropic' });
    }

    if (!payload.has_more || !payload.last_id || payload.last_id === afterId) break;
    afterId = payload.last_id;
  }

  return models;
}

function resolveSubmittedApiKey(raw: unknown): string {
  const submitted = typeof raw === 'string' ? raw.trim() : '';
  if (submitted && submitted !== '__SET__') return submitted;
  if (submitted === '__SET__') return getSetting('ai_api_key', '').trim();
  return '';
}

function isLikelyOpenAiTextModel(id: string): boolean {
  const lowered = id.toLowerCase();
  if (
    /embedding|embed|whisper|tts|audio|transcribe|image|dall-e|moderation|realtime/.test(lowered)
  ) {
    return false;
  }
  return /^(gpt-|o\d|o[1-9]|chatgpt-|ft:(gpt-|o\d|o[1-9]))/.test(lowered);
}

function anthropicApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
}

function friendlyNetworkMessage(message: string): string {
  if (/aborted|timeout/i.test(message)) return 'Timed out reaching the endpoint.';
  if (/ECONNREFUSED|refused/i.test(message)) return 'Connection refused — is the server running?';
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return 'Hostname not found.';
  if (/certificate|SSL|TLS/i.test(message)) return 'TLS/SSL error — check the base URL and certificates.';
  if (/fetch failed/i.test(message)) return 'Could not reach the endpoint.';
  return message;
}

function normalizeBaseUrl(value: string, provider: Exclude<AIProvider, 'disabled'>): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const defaultProtocol = provider === 'custom' ? 'http' : 'https';
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `${defaultProtocol}://${trimmed}`;
  let normalized = withProtocol.replace(/\/+$/, '');

  if ((provider === 'custom' || provider === 'openai') && shouldAppendOpenAiPath(normalized)) {
    normalized = `${normalized}/v1`;
  }

  return normalized;
}

function shouldAppendOpenAiPath(baseUrl: string): boolean {
  if (/\/v1$/i.test(baseUrl)) return false;
  try {
    const parsed = new URL(baseUrl);
    return parsed.pathname === '/' || parsed.pathname === '';
  } catch {
    return false;
  }
}
