import assert from "node:assert/strict";
import test from "node:test";
import {
  requestBulkScrape,
  requestSingleScrape,
} from "../../lib/scrape-client";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("single-app sync rejects HTTP and per-app failures", async () => {
  globalThis.fetch = async () =>
    Response.json({ error: "Too many requests" }, { status: 429 });
  await assert.rejects(
    requestSingleScrape("https://apps.apple.com/app/id1"),
    /Too many requests/
  );

  globalThis.fetch = async () =>
    Response.json({
      results: [{ status: "error", error: "Apple unavailable" }],
    });
  await assert.rejects(
    requestSingleScrape("https://apps.apple.com/app/id1"),
    /Apple unavailable/
  );
});

test("bulk sync respects route cap and reports individual failures", async () => {
  const sizes: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const urls = JSON.parse(String(init?.body)).urls as string[];
    sizes.push(urls.length);
    return Response.json({
      results: urls.map((_url, index) =>
        index === 0 && sizes.length === 2
          ? { status: "error", error: "Missing listing" }
          : { status: "success" }
      ),
    });
  };
  const urls = Array.from(
    { length: 201 },
    (_value, index) => `https://apps.apple.com/app/id${index}`
  );
  const progress: number[] = [];
  const summary = await requestBulkScrape(urls, undefined, (attempted) =>
    progress.push(attempted)
  );
  assert.deepEqual(sizes, [100, 100, 1]);
  assert.deepEqual(progress, [100, 200, 201]);
  assert.deepEqual(summary, {
    succeeded: 200,
    failed: 1,
    attempted: 201,
    total: 201,
    stopped: false,
  });
});

test("bulk sync stops on rate limit and never counts unsent apps", async () => {
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    const urls = JSON.parse(String(init?.body)).urls as string[];
    return Response.json({
      results: urls.map((_url, index) =>
        index === 0
          ? { status: "rate_limited", error: "Try later" }
          : { status: "success" }
      ),
    });
  };
  const summary = await requestBulkScrape(
    Array.from({ length: 201 }, () => "url")
  );
  assert.equal(calls, 1);
  assert.deepEqual(summary, {
    succeeded: 99,
    failed: 1,
    attempted: 100,
    total: 201,
    stopped: true,
  });
});

test("bulk sync rejects incomplete responses", async () => {
  globalThis.fetch = async () => Response.json({ results: [] });
  await assert.rejects(requestBulkScrape(["url"]), /incomplete results/);
});
