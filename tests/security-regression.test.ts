import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';
import {
  sanitizePolicyUrl,
  validateExternalUrl,
} from '../lib/security';
import { resetTestDb } from './test-db';

test.beforeEach(resetTestDb);

test('proxy blocks cross-origin API mutations and still attaches security headers', () => {
  const request = new NextRequest('http://127.0.0.1:3000/api/reset', {
    method: 'POST',
    headers: {
      origin: 'https://attacker.example',
      host: '127.0.0.1:3000',
    },
  });

  const response = proxy(request);

  assert.equal(response.status, 403);
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/);
});

test('proxy allows same-origin mutations and admin-token scripted callers', () => {
  const sameOrigin = proxy(new NextRequest('http://127.0.0.1:3000/api/reset', {
    method: 'POST',
    headers: {
      origin: 'http://127.0.0.1:3000',
      host: '127.0.0.1:3000',
    },
  }));
  assert.notEqual(sameOrigin.status, 403);

  const previousToken = process.env.AUDITOR_ADMIN_TOKEN;
  process.env.AUDITOR_ADMIN_TOKEN = 'ci-secret';
  try {
    const scripted = proxy(new NextRequest('http://127.0.0.1:3000/api/reset', {
      method: 'POST',
      headers: {
        origin: 'https://automation.example',
        host: '127.0.0.1:3000',
        'x-auditor-admin-token': 'ci-secret',
      },
    }));
    assert.notEqual(scripted.status, 403);
  } finally {
    if (previousToken === undefined) delete process.env.AUDITOR_ADMIN_TOKEN;
    else process.env.AUDITOR_ADMIN_TOKEN = previousToken;
  }
});

test('destructive routes require admin token when configured', async () => {
  const previousToken = process.env.AUDITOR_ADMIN_TOKEN;
  process.env.AUDITOR_ADMIN_TOKEN = 'reset-secret';
  try {
    const route = await import('../app/api/reset/route');
    const response = await route.POST(new Request('http://127.0.0.1/api/reset', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Admin token required' });
  } finally {
    if (previousToken === undefined) delete process.env.AUDITOR_ADMIN_TOKEN;
    else process.env.AUDITOR_ADMIN_TOKEN = previousToken;
  }
});

test('backup restore rejects malformed JSON before mutating data', async () => {
  const route = await import('../app/api/backup/restore/route');
  const response = await route.POST(new Request('http://127.0.0.1/api/backup/restore', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.11',
    },
    body: '{not json',
  }));

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /not valid JSON/i);
});

test('policy URL sanitiser keeps metadata endpoints blocked even for localhost-friendly callers', () => {
  assert.equal(
    validateExternalUrl('http://169.254.169.254/latest/meta-data', {
      allowPrivateHosts: true,
    }).ok,
    false,
  );
  assert.equal(sanitizePolicyUrl('http://metadata.google.internal/computeMetadata/v1'), '');
});
