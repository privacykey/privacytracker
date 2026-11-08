import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readAppCount } from "../../lib/app-count";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch with one that answers from `replies`, in order. */
function stubFetch(replies: Array<() => Response>): { calls: string[] } {
  const seen = { calls: [] as string[] };
  globalThis.fetch = ((input: RequestInfo | URL) => {
    seen.calls.push(String(input));
    const reply = replies.shift();
    assert.ok(reply, "fetch was called more often than expected");
    return Promise.resolve(reply());
  }) as typeof fetch;
  return seen;
}

const total = (value: unknown) => () => Response.json({ total: value });
const serverError = () => new Response("{}", { status: 500 });

test("overlapping callers share one request and one answer", async () => {
  const seen = stubFetch([total(7)]);
  const [first, second] = await Promise.all([readAppCount(), readAppCount()]);
  assert.equal(first, 7);
  assert.equal(second, 7);
  assert.deepEqual(seen.calls, ["/api/apps?limit=1"]);
});

test("a settled read is not reused", async () => {
  const seen = stubFetch([total(1), total(2)]);
  assert.equal(await readAppCount(), 1);
  assert.equal(await readAppCount(), 2);
  assert.equal(seen.calls.length, 2);
});

test("a failed read rejects every caller, and the next read asks again", async () => {
  const seen = stubFetch([serverError, total(3)]);
  const results = await Promise.allSettled([readAppCount(), readAppCount()]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected"]
  );
  assert.equal(seen.calls.length, 1);

  assert.equal(await readAppCount(), 3);
  assert.equal(seen.calls.length, 2);
});

test("a reply with no numeric total is a failure, not zero apps", async () => {
  stubFetch([total("many")]);
  await assert.rejects(readAppCount(), /Invalid apps count/);
});
