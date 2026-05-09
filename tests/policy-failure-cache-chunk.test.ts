import assert from 'node:assert/strict';
import test from 'node:test';
import db from '../lib/db';
import { setSetting } from '../lib/scheduler';
import { getPolicyAnalysis, syncPrivacyPolicyAnalysis } from '../lib/privacy-policy';
import { POLICY_LENSES } from '../lib/policy-summary-meta';
import { resetTestDb, seedTrackedApp } from './test-db';

const originalFetch = global.fetch;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;

test.beforeEach(() => {
  resetTestDb();
  console.info = () => {};
  console.warn = () => {};
  setSetting('policy_scrape_throttle_enabled', 'false');
});

test.afterEach(() => {
  global.fetch = originalFetch;
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
});

test('policy sync records too-short and unsupported-content failures without calling AI', async () => {
  configureOpenAi();
  seedTrackedApp({ id: 'too-short-app', name: 'Too Short', privacyPolicyUrl: 'https://example.com/short' });
  seedTrackedApp({ id: 'pdf-app', name: 'PDF Policy', privacyPolicyUrl: 'https://example.com/policy.pdf' });
  let aiCalls = 0;

  global.fetch = (async (raw: string | URL | Request) => {
    const url = String(raw);
    if (url === 'https://example.com/short') {
      return new Response('We collect data.', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (url === 'https://example.com/policy.pdf') {
      return new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    if (url.endsWith('/chat/completions')) {
      aiCalls += 1;
      return aiSummaryResponse('Should not be called');
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const tooShort = await syncPrivacyPolicyAnalysis({
    appId: 'too-short-app',
    appName: 'Too Short',
    policyUrl: 'https://example.com/short',
  }, { bypassThrottle: true });
  const unsupported = await syncPrivacyPolicyAnalysis({
    appId: 'pdf-app',
    appName: 'PDF Policy',
    policyUrl: 'https://example.com/policy.pdf',
  }, { bypassThrottle: true });

  assert.equal(tooShort?.status, 'too_short');
  assert.equal(unsupported?.status, 'unsupported_content_type');
  assert.equal(aiCalls, 0);
});

test('blocked policy fetch stores diagnostics for the activity log', async () => {
  configureOpenAi();
  seedTrackedApp({ id: 'blocked-app', name: 'Blocked Policy', privacyPolicyUrl: 'https://example.com/blocked' });

  global.fetch = (async (raw: string | URL | Request) => {
    const url = String(raw);
    if (url === 'https://example.com/blocked') {
      return new Response('blocked', { status: 403, headers: { 'content-type': 'text/html' } });
    }
    if (url.startsWith('https://archive.org/wayback/available')) {
      return new Response(JSON.stringify({ archived_snapshots: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const result = await syncPrivacyPolicyAnalysis({
    appId: 'blocked-app',
    appName: 'Blocked Policy',
    policyUrl: 'https://example.com/blocked',
  }, { bypassThrottle: true });

  assert.equal(result?.status, 'fetch_error');
  assert.match(result?.error ?? '', /blocked|Wayback/i);

  const activity = db.prepare(`
    SELECT detail FROM activity_log
    WHERE app_id = ? AND type = 'policy_summary'
    ORDER BY started_at DESC
    LIMIT 1
  `).get('blocked-app') as { detail: string };
  const detail = JSON.parse(activity.detail) as {
    fetchDiagnostics?: { requestedUrl?: string; origin?: string; troubleshoot?: string[] };
  };
  assert.equal(detail.fetchDiagnostics?.requestedUrl, 'https://example.com/blocked');
  assert.equal(detail.fetchDiagnostics?.origin, 'wayback');
  assert.ok((detail.fetchDiagnostics?.troubleshoot ?? []).length > 0);
});

test('unchanged policy text skips AI, while changed text preserves the previous summary', async () => {
  configureOpenAi();
  seedTrackedApp({ id: 'cache-app', name: 'Cache Policy', privacyPolicyUrl: 'https://example.com/cache' });
  let policyText = longEnoughPolicyText('first');
  const aiOverviews = ['First summary', 'Second summary'];
  const aiRequests: string[] = [];

  global.fetch = (async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw);
    if (url === 'https://example.com/cache') {
      return new Response(policyText, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      aiRequests.push(body.messages[1].content);
      return aiSummaryResponse(aiOverviews.shift() ?? 'Unexpected extra summary');
    }
    if (url.startsWith('https://archive.org/wayback/available')) {
      return new Response(JSON.stringify({ archived_snapshots: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('https://web.archive.org/save/')) {
      return new Response('', { status: 200, headers: { 'content-location': '/web/20260101000000/https://example.com/cache' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const first = await syncPrivacyPolicyAnalysis({
    appId: 'cache-app',
    appName: 'Cache Policy',
    policyUrl: 'https://example.com/cache',
  }, { bypassThrottle: true });
  await syncPrivacyPolicyAnalysis({
    appId: 'cache-app',
    appName: 'Cache Policy',
    policyUrl: 'https://example.com/cache',
  }, { bypassThrottle: true });
  policyText = longEnoughPolicyText('changed');
  const changed = await syncPrivacyPolicyAnalysis({
    appId: 'cache-app',
    appName: 'Cache Policy',
    policyUrl: 'https://example.com/cache',
  }, { bypassThrottle: true });

  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(first?.summary?.overview, 'First summary');
  assert.equal(changed?.summary?.overview, 'Second summary');
  assert.equal(changed?.previousSummary?.overview, 'First summary');
  assert.equal(aiRequests.length, 2);
});

test('long policy text uses chunked AI summarisation and stores reusable chunk notes', async () => {
  configureOpenAi({ model: 'qwen2.5:7b' });
  seedTrackedApp({ id: 'chunk-app', name: 'Chunk Policy', privacyPolicyUrl: 'https://example.com/chunk' });
  const requestNames: string[] = [];

  global.fetch = (async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw);
    if (url === 'https://example.com/chunk') {
      return new Response(longEnoughPolicyText('chunk').repeat(4), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      const schemaName = body.response_format.json_schema.name;
      requestNames.push(schemaName);
      if (schemaName === 'privacy_policy_chunk_note') {
        return openAiContentResponse({
          summary: 'This chunk discusses collection, sharing, controls, retention, and children.',
          highlights: [
            'Collects account and device data.',
            'Shares with service providers and analytics partners.',
            'Provides deletion and opt-out controls.',
          ],
        });
      }
      return aiSummaryResponse('Chunked final summary');
    }
    if (url.startsWith('https://archive.org/wayback/available')) {
      return new Response(JSON.stringify({ archived_snapshots: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('https://web.archive.org/save/')) {
      return new Response('', { status: 200, headers: { 'content-location': '/web/20260101000000/https://example.com/chunk' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const result = await syncPrivacyPolicyAnalysis({
    appId: 'chunk-app',
    appName: 'Chunk Policy',
    policyUrl: 'https://example.com/chunk',
  }, { bypassThrottle: true });

  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(result?.status, 'ready');
  assert.equal(result.analysisMode, 'chunked');
  assert.ok(requestNames.filter(name => name === 'privacy_policy_chunk_note').length >= 2);
  assert.equal(requestNames.at(-1), 'privacy_policy_summary_from_chunks');

  const stored = getPolicyAnalysis('chunk-app');
  assert.equal(stored?.chunkNotes?.length, requestNames.length - 1);
  assert.equal(stored?.summary?.overview, 'Chunked final summary');
});

function configureOpenAi(opts: { model?: string } = {}) {
  setSetting('ai_provider', 'openai');
  setSetting('ai_model', opts.model ?? 'fixture-policy-model');
  setSetting('ai_api_key', 'fixture-key');
  setSetting('ai_base_url', 'https://api.openai.test/v1');
}

function longEnoughPolicyText(marker: string): string {
  const paragraph = [
    `This ${marker} privacy policy explains how the developer collects account information, contact information, device identifiers, usage data, diagnostics, and approximate location data.`,
    'We use personal information to provide the product, secure accounts, prevent fraud, personalize features, perform analytics, measure advertising, send marketing communications, and improve services.',
    'We share data with service providers, affiliates, analytics partners, advertising partners, payment processors, professional advisers, and legal authorities where required.',
    'Cookies, SDKs, device identifiers, and similar tracking technologies help remember settings, measure app performance, understand feature usage, and limit repeated ads.',
    'Users may request access, correction, deletion, portability, opt out of marketing, limit certain tracking, withdraw consent, and contact privacy@example.com for rights requests.',
    'We retain account records while an account remains active, retain security logs for up to twenty four months, and delete or de-identify information when it is no longer needed.',
    'The service is not directed to children under thirteen and does not knowingly collect children personal information without appropriate consent.',
  ].join(' ');
  return Array.from({ length: 12 }, (_, index) => `${paragraph} Section ${index + 1}.`).join('\n\n');
}

function aiSummaryResponse(overview: string): Response {
  return openAiContentResponse({
    overview,
    highlights: ['Collection is disclosed.', 'Sharing is disclosed.', 'Controls are disclosed.'],
    lenses: POLICY_LENSES.map(({ key }) => ({
      key,
      rating: key === 'collection_scope' ? 'mixed' : 'favorable',
      summary: `The policy includes evidence for ${key}.`,
    })),
  });
}

function openAiContentResponse(content: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
