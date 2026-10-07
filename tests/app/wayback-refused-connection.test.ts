/**
 * archive.org refusing the connection is throttling, not an empty archive.
 *
 * Once archive.org has throttled a client for long enough it stops
 * answering 429 and refuses the TCP connection outright. The import used to
 * read that as "no capture": the CDX index fell back to up to seven
 * availability probes per target, each refused too, every target landed as
 * `skipped_no_capture`, and the bulk runner marked the app done with no
 * history before racing on to the next one. These pin the other reading:
 * a request that fails below HTTP throws `WaybackUnavailableError`, and the
 * bulk runner backs off (five minutes, as a refusal carries no Retry-After)
 * and then pauses the queue as rate-limited.
 */

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import db from "../../lib/db";
import { importAppHistory } from "../../lib/historical-import";
import {
  listWaybackCaptures,
  WaybackUnavailableError,
  waybackTransportFailure,
} from "../../lib/wayback";
import {
  rateLimitBackoffMs,
  runBulkWaybackImport,
} from "../../lib/wayback-bulk-runner";
import { isBulkMutexHeld, readBulkState } from "../../lib/wayback-bulk-state";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const APP_ID = "555000111";
const APP_URL = `https://apps.apple.com/us/app/fixture/id${APP_ID}`;
const APP = { id: APP_ID, name: "Fixture", url: APP_URL };
const TODAY = new Date(Date.UTC(2021, 10, 1, 12));
const CAPTURE = "20210215120000";

const originalFetch = global.fetch;
test.afterEach(() => {
  global.fetch = originalFetch;
});

/** What undici's fetch rejects with when the connection is refused. */
function refused(): TypeError {
  const cause = Object.assign(
    new Error("connect ECONNREFUSED 207.241.224.2:443"),
    { code: "ECONNREFUSED" }
  );
  return new TypeError("fetch failed", { cause });
}

type Endpoint = "cdx" | "availability" | "replay" | "save";

function endpointOf(url: string): Endpoint {
  if (url.startsWith("https://web.archive.org/cdx/search/cdx")) {
    return "cdx";
  }
  if (url.startsWith("https://archive.org/wayback/available")) {
    return "availability";
  }
  if (url.startsWith("https://web.archive.org/save/")) {
    return "save";
  }
  if (/^https:\/\/web\.archive\.org\/web\/\d{14}id_\//.test(url)) {
    return "replay";
  }
  throw new Error(`Unexpected fetch: ${url}`);
}

/** Route each archive endpoint to a handler; count the calls. */
function stubArchive(
  handlers: Partial<Record<Endpoint, () => Response | Promise<Response>>>
) {
  const calls: Record<Endpoint, number> = {
    cdx: 0,
    availability: 0,
    replay: 0,
    save: 0,
  };
  global.fetch = (async (input: string | URL | Request) => {
    const endpoint = endpointOf(String(input));
    calls[endpoint] += 1;
    const handler = handlers[endpoint];
    if (!handler) {
      throw new Error(`No stub for ${endpoint}`);
    }
    return handler();
  }) as typeof fetch;
  return calls;
}

function waybackRowCount(): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM privacy_snapshots WHERE app_id = ? AND source = 'wayback'"
      )
      .get(APP_ID) as { n: number }
  ).n;
}

test("a refused connection to the CDX index throws instead of falling back to probes", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  const calls = stubArchive({
    cdx: () => {
      throw refused();
    },
  });

  await assert.rejects(
    importAppHistory(APP, { today: TODAY }),
    (error: unknown) => {
      assert.ok(error instanceof WaybackUnavailableError);
      assert.equal(
        error.message,
        "archive.org refused the connection for CDX index"
      );
      assert.equal(error.status, 0, "no response, so no HTTP status");
      assert.equal(error.retryAfterMs, null);
      return true;
    }
  );
  assert.deepEqual(
    calls,
    { cdx: 1, availability: 0, replay: 0, save: 0 },
    "one refused request, not seven more per target and a Save Page Now"
  );
  assert.equal(waybackRowCount(), 0);
});

test("a refused availability probe throws on the first probe", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  // An index that answers 404 is unusable, so the import probes instead.
  const calls = stubArchive({
    cdx: () => new Response("", { status: 404 }),
    availability: () => {
      throw refused();
    },
  });

  await assert.rejects(
    importAppHistory(APP, { today: TODAY }),
    (error: unknown) =>
      error instanceof WaybackUnavailableError &&
      error.message ===
        "archive.org refused the connection for availability API"
  );
  assert.equal(calls.availability, 1);
  assert.equal(calls.save, 0);
});

test("a refused replay throws instead of skipping the target as a fetch failure", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, url: APP_URL });
  const calls = stubArchive({
    cdx: () =>
      new Response(
        JSON.stringify([
          ["timestamp", "statuscode"],
          [CAPTURE, "200"],
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
    replay: () => {
      throw refused();
    },
  });

  await assert.rejects(
    importAppHistory(APP, { today: TODAY }),
    (error: unknown) =>
      error instanceof WaybackUnavailableError &&
      error.message === "archive.org refused the connection for replay"
  );
  assert.deepEqual(calls, { cdx: 1, availability: 0, replay: 1, save: 0 });
  assert.equal(waybackRowCount(), 0);
});

test("a timed-out index throws, while an unusable index still falls back", async () => {
  global.fetch = (async () => {
    throw new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError"
    );
  }) as typeof fetch;
  await assert.rejects(
    listWaybackCaptures(APP_URL),
    (error: unknown) =>
      error instanceof WaybackUnavailableError &&
      error.message === "archive.org timed out for CDX index"
  );

  // A body over the cap is not archive.org refusing us: the import probes.
  global.fetch = (async () =>
    new Response("[]", {
      status: 200,
      headers: { "content-length": String(2 * 1024 * 1024) },
    })) as typeof fetch;
  assert.equal(await listWaybackCaptures(APP_URL), null);
});

test("only failures below HTTP count as transport failures", () => {
  const sorted = [
    ["fetch failed", "refused the connection"],
    ["terminated", "dropped the connection"],
    ["The operation was aborted due to timeout", "timed out"],
    [
      "Blocked URL: host web.archive.org did not resolve to a public address",
      "could not be resolved",
    ],
  ] as const;
  for (const [message, label] of sorted) {
    assert.equal(
      waybackTransportFailure(new Error(message), "replay")?.message,
      `archive.org ${label} for replay`
    );
  }
  for (const error of [
    new Error("Blocked URL: invalid_url — https://example.com"),
    new Error("safeFetch: response exceeded 4194304 bytes"),
    new Error("safeFetch: too many redirects (6)"),
    new DOMException("This operation was aborted", "AbortError"),
    "fetch failed",
    null,
  ]) {
    assert.equal(waybackTransportFailure(error, "replay"), null);
  }
});

test("with no Retry-After the bulk runner waits five minutes, capped at fifteen", () => {
  assert.equal(rateLimitBackoffMs(null), 300_000);
  assert.equal(rateLimitBackoffMs(1), 1000);
  assert.equal(rateLimitBackoffMs(5000), 5000);
  assert.equal(rateLimitBackoffMs(600_000), 600_000);
  assert.equal(rateLimitBackoffMs(3_600_000), 900_000);
});

test("the bulk runner backs off from a refused connection, then pauses instead of finishing the app", async () => {
  resetTestDb();
  seedTrackedApp({ id: APP_ID, name: "Alpha", url: APP_URL });
  seedTrackedApp({
    id: "555000222",
    name: "Beta",
    url: "https://apps.apple.com/us/app/beta/id555000222",
  });
  const calls = stubArchive({
    cdx: () => {
      throw refused();
    },
  });

  // The five-minute wait runs on a mocked clock.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const events: Record<string, unknown>[] = [];
    const run = runBulkWaybackImport({
      initiator: "manual",
      streamWriter: (event) => events.push(event as Record<string, unknown>),
    });
    let settled = false;
    run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    // The backoff frame is written just before the wait's timer is set.
    while (!(settled || events.some((event) => event.type === "backoff"))) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const backoff = events.find((event) => event.type === "backoff");
    assert.ok(backoff, "the runner backs off instead of finishing the app");
    assert.equal(backoff.delayMs, 300_000);
    assert.equal(
      backoff.reason,
      "archive.org refused the connection for CDX index"
    );
    assert.equal(calls.cdx, 1, "nothing is retried before the wait is over");
    mock.timers.tick(300_000);

    const result = await run;

    // Alpha: refused → wait → retry → refused → pause. Beta never started,
    // and no availability probe or Save Page Now was attempted.
    assert.deepEqual(calls, { cdx: 2, availability: 0, replay: 0, save: 0 });
    assert.equal(result.totals.appsAttempted, 0);
    assert.equal(result.totals.failed, 0, "throttling is not an app failure");
    assert.ok(events.some((event) => event.type === "paused"));
    const state = readBulkState();
    assert.ok(state);
    assert.equal(state.status, "paused");
    assert.equal(state.pauseCause, "rate_limited");
    assert.deepEqual(
      state.queue.map((entry) => entry.status),
      ["pending", "pending"],
      "Alpha is pending, not done with no history"
    );
    assert.equal(
      state.queue[0].error,
      "archive.org refused the connection for CDX index"
    );
    assert.equal(isBulkMutexHeld(), false);
    assert.equal(waybackRowCount(), 0);
  } finally {
    mock.timers.reset();
  }
});
