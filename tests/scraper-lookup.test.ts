import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupAppsByBundleId } from '../lib/scraper';
import { clearRateLimit, _resetSoftBuckets } from '../lib/rate-limit';

/**
 * Tests for the iTunes lookup-by-bundleId helper. We mock global.fetch
 * to avoid hitting Apple in CI — the same pattern scraper-fixture.test.ts
 * uses for its end-to-end test.
 *
 * Each test resets the rate-limit state up front so a stale 429 from a
 * previous test (or pre-existing dev data in app_settings) can't make
 * the lookup short-circuit before our mock fetch runs.
 */

const originalFetch = global.fetch;

function reset() {
  clearRateLimit('search');
  clearRateLimit('scrape');
  _resetSoftBuckets();
}

test.beforeEach(reset);

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('lookupAppsByBundleId resolves matches in input order', async () => {
  let receivedUrl = '';
  global.fetch = (async (input: string | URL | Request) => {
    receivedUrl = String(input);
    return new Response(JSON.stringify({
      resultCount: 2,
      results: [
        {
          trackId: 12345,
          trackName: 'Twitter',
          artistName: 'X Corp.',
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/.../100x100bb.jpg',
          trackViewUrl: 'https://apps.apple.com/us/app/twitter/id12345?mt=8',
          bundleId: 'com.atebits.Tweetie2',
        },
        {
          trackId: 67890,
          trackName: 'Organic Maps',
          artistName: 'Organic Maps OÜ',
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/.../100x100bb.jpg',
          trackViewUrl: 'https://apps.apple.com/us/app/organic-maps/id67890',
          bundleId: 'app.organicmaps',
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const batch = await lookupAppsByBundleId(['com.atebits.Tweetie2', 'app.organicmaps']);

  assert.equal(batch.results.length, 2);
  assert.equal(batch.rateLimited, undefined);

  // Order preserved (input → output) regardless of Apple's response order.
  assert.equal(batch.results[0].bundleId, 'com.atebits.Tweetie2');
  assert.equal(batch.results[0].match?.name, 'Twitter');
  assert.equal(batch.results[0].match?.searchQuery, 'com.atebits.Tweetie2');
  assert.equal(batch.results[1].bundleId, 'app.organicmaps');
  assert.equal(batch.results[1].match?.name, 'Organic Maps');

  // URL is shaped correctly: comma-joined IDs, country, lookup endpoint.
  assert.match(receivedUrl, /itunes\.apple\.com\/lookup/);
  assert.match(receivedUrl, /bundleId=/);
  assert.match(receivedUrl, /country=/);
});

test('lookupAppsByBundleId returns null match for IDs Apple did not return', async () => {
  global.fetch = (async () => {
    return new Response(JSON.stringify({
      resultCount: 1,
      results: [{
        trackId: 12345,
        trackName: 'Real App',
        artistName: 'Real Dev',
        artworkUrl100: '',
        trackViewUrl: 'https://apps.apple.com/us/app/real/id12345',
        bundleId: 'com.real.app',
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const batch = await lookupAppsByBundleId(['com.real.app', 'com.delisted.ghost']);

  assert.equal(batch.results.length, 2);
  assert.equal(batch.results[0].match?.name, 'Real App');
  // Delisted/sideloaded apps come back with `match: null`, never undefined,
  // never absent — every input ID gets exactly one row in `results`.
  assert.equal(batch.results[1].bundleId, 'com.delisted.ghost');
  assert.equal(batch.results[1].match, null);
});

test('lookupAppsByBundleId dedupes input IDs', async () => {
  let bodyUrl = '';
  global.fetch = (async (input: string | URL | Request) => {
    bodyUrl = String(input);
    return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const batch = await lookupAppsByBundleId([
    'com.foo',
    'com.bar',
    'com.foo', // duplicate
    '',        // empty (filtered)
    'com.bar', // duplicate
  ]);

  assert.equal(batch.results.length, 2);
  // The URL should encode each ID exactly once.
  const idSegment = decodeURIComponent(
    (/bundleId=([^&]*)/.exec(bodyUrl) ?? [])[1] ?? '',
  );
  assert.equal(idSegment.split(',').sort().join(','), 'com.bar,com.foo');
});

test('lookupAppsByBundleId surfaces 429 with retryAfter and queued tail', async () => {
  global.fetch = (async () => {
    return new Response('Too Many Requests', {
      status: 429,
      headers: { 'retry-after': '60', 'content-type': 'text/plain' },
    });
  }) as typeof fetch;

  const batch = await lookupAppsByBundleId(['com.foo', 'com.bar', 'com.baz']);

  assert.equal(batch.results.length, 0);
  assert.ok(batch.rateLimited, 'rateLimited envelope should be present');
  assert.equal(batch.rateLimited?.retryAfterMs, 60_000);
  assert.deepEqual(batch.rateLimited?.queued, ['com.foo', 'com.bar', 'com.baz']);
});

test('lookupAppsByBundleId returns empty result for empty input', async () => {
  global.fetch = (async () => {
    throw new Error('fetch should not be called for empty input');
  }) as typeof fetch;

  const batch = await lookupAppsByBundleId([]);
  assert.equal(batch.results.length, 0);
  assert.equal(batch.rateLimited, undefined);
});

test('lookupAppsByBundleId returns null match for non-200 responses', async () => {
  global.fetch = (async () => {
    return new Response('upstream sad', { status: 503 });
  }) as typeof fetch;

  const batch = await lookupAppsByBundleId(['com.foo', 'com.bar']);

  assert.equal(batch.results.length, 2);
  assert.equal(batch.results[0].match, null);
  assert.equal(batch.results[1].match, null);
  // 503 isn't a rate-limit signal — caller should fall back to name search,
  // not back off on a cooldown.
  assert.equal(batch.rateLimited, undefined);
});
