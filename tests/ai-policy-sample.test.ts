import assert from 'node:assert/strict';
import test from 'node:test';
import db from '../lib/db';
import { setSetting } from '../lib/scheduler';
import { POLICY_LENSES } from '../lib/policy-summary-meta';
import { resetTestDb } from './test-db';

type SampleRoute = {
  POST(request: Request): Promise<Response>;
};

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
  resetTestDb();
});

test('sample policy summary route uses the selected model and saved masked OpenAI key', async () => {
  resetTestDb();
  setSetting('ai_api_key', 'saved-openai-key');

  const aiRequests: Array<Record<string, any>> = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.openai.test/v1/chat/completions') {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer saved-openai-key');
      const requestBody = JSON.parse(String(init?.body)) as Record<string, any>;
      aiRequests.push(requestBody);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(buildSampleSummaryResponse()),
          },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch in sample policy test: ${url}`);
  }) as typeof fetch;

  const route = (await import('../app/api/ai/policy-sample/route')) as SampleRoute;
  const res = await route.POST(new Request('http://127.0.0.1/api/ai/policy-sample', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': 'ai-policy-sample-openai',
    },
    body: JSON.stringify({
      provider: 'openai',
      apiKey: '__SET__',
      baseUrl: 'https://api.openai.test',
      model: 'gpt-sample-quality',
    }),
  }));

  assert.equal(res.status, 200);
  const body = await res.json() as {
    ok?: boolean;
    model?: string;
    summary?: { lenses?: Array<{ key: string; rating: string }> };
    sample?: {
      appName?: string;
      scenario?: string;
      reviewChecklist?: string[];
      expectedSignals?: string[];
      policyText?: string;
    };
  };
  assert.equal(body.ok, true);
  assert.equal(body.model, 'gpt-sample-quality');
  assert.equal(body.sample?.appName, 'Sample Notes');
  assert.match(body.sample?.scenario ?? '', /fictional notes app/i);
  assert.ok(body.sample?.reviewChecklist?.some(item => /Judge the selected model/.test(item)));
  assert.ok((body.sample?.expectedSignals?.length ?? 0) >= 8);
  assert.match(body.sample?.policyText ?? '', /We do not sell personal information/);
  assert.deepEqual(body.summary?.lenses?.map(lens => lens.key), POLICY_LENSES.map(lens => lens.key));

  assert.equal(aiRequests.length, 1);
  assert.equal(aiRequests[0].model, 'gpt-sample-quality');
  assert.equal(aiRequests[0].response_format.json_schema.name, 'privacy_policy_summary');
  assert.match(aiRequests[0].messages[1].content, /Example App Co/);
  assert.match(aiRequests[0].messages[1].content, /Sample Notes/);
  assert.match(aiRequests[0].messages[1].content, /We do not sell personal information/);

  const activity = db.prepare(
    `SELECT type, status, app_id, app_name, summary, detail
       FROM activity_log
      WHERE type = 'policy_summary'
      ORDER BY started_at DESC
      LIMIT 1`,
  ).get() as {
    type: string;
    status: string;
    app_id: string | null;
    app_name: string | null;
    summary: string;
    detail: string;
  };

  assert.equal(activity.status, 'ok');
  assert.equal(activity.app_id, null);
  assert.equal(activity.app_name, 'Sample Notes');
  assert.match(activity.summary, /Sample policy model test complete/);
  assert.equal(JSON.parse(activity.detail).sample, true);
});

function buildSampleSummaryResponse() {
  return {
    overview: 'Example App Co. collects account, device, usage, diagnostics, and optional location data to run and secure Sample Notes.',
    highlights: [
      'The policy says it does not sell personal information or use third-party ad networks.',
      'It shares data with service providers, analytics partners, payment processors, affiliates, and authorities when required.',
      'It offers access, deletion, export, marketing opt-out, analytics opt-out, and account closure controls.',
    ],
    lenses: POLICY_LENSES.map(({ key }) => ({
      key,
      rating: key === 'ads_marketing' || key === 'data_retention' ? 'favorable' : 'mixed',
      summary: `The sample policy includes concrete support for ${key}.`,
    })),
  };
}
