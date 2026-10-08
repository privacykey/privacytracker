import assert from "node:assert/strict";
import test from "node:test";
import {
  archivedHistoryStartsLate,
  describeWaybackAppImport,
  describeWaybackAppImportFailure,
  parseWaybackAppImportResult,
  WAYBACK_HISTORY_FLOOR_MS,
  WAYBACK_LATE_START_MS,
} from "../../lib/wayback-app-import";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 3, 50);

/** What the route answers today, and still answers on the Node rollback. */
const legacy = (fields: Record<string, number>) =>
  parseWaybackAppImportResult({
    attempted: 24,
    imported: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    snapshotsRequested: 0,
    targets: [],
    ...fields,
  })!;

/** A change-finding (Rust) result. */
const v3 = (fields: Record<string, number | null>) =>
  parseWaybackAppImportResult({
    imported: 2,
    unchanged: 2,
    skipped: 0,
    failed: 0,
    snapshotsRequested: 0,
    reads: 14,
    changes: 1,
    labelVersions: 2,
    firstCaptureMs: WAYBACK_HISTORY_FLOOR_MS + 10 * DAY,
    lastCaptureMs: NOW - DAY,
    windows: [{ fromMs: 1, toMs: 2 }],
    ...fields,
  })!;

test("a result without the new fields reads as it always has", () => {
  assert.deepEqual(
    describeWaybackAppImport(legacy({ imported: 1, unchanged: 20 })),
    {
      alternates: null,
      headline: { key: "result_imported", values: { count: 21 } },
      notes: [],
      rowsAdded: 21,
    }
  );
  assert.deepEqual(describeWaybackAppImport(legacy({})), {
    alternates: null,
    headline: { key: "result_nothing_new" },
    notes: [],
    rowsAdded: 0,
  });
  // One note at most, failures first.
  assert.deepEqual(
    describeWaybackAppImport(
      legacy({ imported: 1, failed: 2, snapshotsRequested: 1 })
    ).notes,
    [{ key: "note_failed", values: { count: 2 } }]
  );
  assert.deepEqual(
    describeWaybackAppImport(legacy({ snapshotsRequested: 1 })).notes,
    [{ key: "note_snapshot_requested" }]
  );
});

test("a change-finding result answers in label changes", () => {
  assert.deepEqual(describeWaybackAppImport(v3({ changes: 3 })), {
    alternates: null,
    headline: { key: "result_changes", values: { count: 3 } },
    notes: [{ key: "note_reads", values: { count: 14 } }],
    rowsAdded: 4,
  });
  assert.deepEqual(
    describeWaybackAppImport(v3({ changes: 0, imported: 1, unchanged: 1 }))
      .headline,
    { key: "result_changes", values: { count: 0 } }
  );
});

test("changes already on the timeline say so", () => {
  const outcome = describeWaybackAppImport(
    v3({ changes: 2, imported: 0, unchanged: 0 })
  );
  assert.deepEqual(outcome.headline, {
    key: "result_changes_on_file",
    values: { count: 2 },
  });
  assert.equal(outcome.rowsAdded, 0);
});

test("an app with no archived pages says so", () => {
  const outcome = describeWaybackAppImport(
    v3({
      changes: 0,
      reads: 0,
      labelVersions: 0,
      imported: 0,
      unchanged: 0,
      firstCaptureMs: null,
      lastCaptureMs: null,
    })
  );
  assert.deepEqual(outcome, {
    alternates: null,
    headline: { key: "result_no_archive" },
    notes: [],
    rowsAdded: 0,
  });
});

test("pages that carried no labels are not reported as unchanged labels", () => {
  // Every capture read was unusable, e.g. the first weeks of February 2021.
  const outcome = describeWaybackAppImport(
    v3({ changes: 0, labelVersions: 0, reads: 4, imported: 0, unchanged: 0 })
  );
  assert.deepEqual(outcome, {
    alternates: null,
    headline: { key: "result_no_labels" },
    notes: [{ key: "note_reads", values: { count: 4 } }],
    rowsAdded: 0,
  });
  // Without a labelVersions count there is nothing to tell them apart by.
  assert.deepEqual(
    describeWaybackAppImport(v3({ changes: 0, labelVersions: null })).headline,
    { key: "result_changes", values: { count: 0 } }
  );
});

test("stored history never reads as no archived pages", () => {
  // The index answered empty and nothing was read, but rows on file carry
  // labels: changes and labelVersions count them.
  const outcome = describeWaybackAppImport(
    v3({
      changes: 2,
      reads: 0,
      labelVersions: 3,
      imported: 0,
      unchanged: 0,
      firstCaptureMs: null,
      lastCaptureMs: null,
    })
  );
  assert.deepEqual(outcome.headline, {
    key: "result_changes_on_file",
    values: { count: 2 },
  });
});

test("archived history that starts well after February 2021 is noted first", () => {
  const first = Date.UTC(2023, 7, 12);
  assert.deepEqual(
    describeWaybackAppImport(v3({ firstCaptureMs: first, failed: 1 })).notes,
    [
      { key: "note_starts_on", values: { dateMs: first } },
      { key: "note_failed", values: { count: 1 } },
    ]
  );
});

test("the late-start threshold is about 180 days after the floor", () => {
  const edge = WAYBACK_HISTORY_FLOOR_MS + WAYBACK_LATE_START_MS;
  assert.equal(archivedHistoryStartsLate(null), false);
  assert.equal(archivedHistoryStartsLate(WAYBACK_HISTORY_FLOOR_MS), false);
  assert.equal(archivedHistoryStartsLate(edge), false);
  assert.equal(archivedHistoryStartsLate(edge + DAY), true);
  assert.equal(WAYBACK_HISTORY_FLOOR_MS, Date.UTC(2021, 1, 1));
});

test("a body without a result, or not an object, parses as nothing", () => {
  assert.equal(parseWaybackAppImportResult(undefined), null);
  assert.equal(parseWaybackAppImportResult(null), null);
  assert.equal(parseWaybackAppImportResult([1, 2]), null);
  const odd = parseWaybackAppImportResult({ imported: "3", changes: "1" })!;
  assert.equal(odd.imported, 0);
  assert.equal(odd.changes, null);
});

test("a throttled import names the time to try again", () => {
  assert.deepEqual(
    describeWaybackAppImportFailure(
      503,
      { code: "archive_unavailable", error: "429", retryAfterMs: 120_000 },
      "120",
      NOW
    ),
    { key: "failed_archive_busy_until", values: { retryAtMs: NOW + 120_000 } }
  );
  // Rust sends null and Node omits the key when archive.org gave no
  // Retry-After; the header is the fallback, then plain words.
  assert.deepEqual(
    describeWaybackAppImportFailure(
      503,
      { code: "archive_unavailable", retryAfterMs: null },
      "300",
      NOW
    ),
    { key: "failed_archive_busy_until", values: { retryAtMs: NOW + 300_000 } }
  );
  assert.deepEqual(
    describeWaybackAppImportFailure(
      503,
      { code: "archive_unavailable" },
      null,
      NOW
    ),
    { key: "failed_archive_busy" }
  );
});

test("other failures keep the route's message, else the status", () => {
  assert.deepEqual(
    describeWaybackAppImportFailure(
      400,
      { error: "App has no URL" },
      null,
      NOW
    ),
    { message: "App has no URL" }
  );
  assert.deepEqual(describeWaybackAppImportFailure(502, null, null, NOW), {
    key: "failed_status",
    values: { status: 502 },
  });
  assert.deepEqual(
    describeWaybackAppImportFailure(429, { error: "" }, "60", NOW),
    { key: "failed_status", values: { status: 429 } }
  );
});

// ── Coverage (P5): the server's late-start verdict and older addresses ──

/** A result from the coverage-aware route. */
const p5 = (fields: Record<string, unknown>) =>
  parseWaybackAppImportResult({
    imported: 2,
    unchanged: 2,
    skipped: 0,
    failed: 0,
    snapshotsRequested: 0,
    reads: 14,
    changes: 1,
    labelVersions: 2,
    firstCaptureMs: Date.UTC(2023, 7, 12),
    lastCaptureMs: NOW - DAY,
    lookupUrl: "https://apps.apple.com/us/app/new-name/id42",
    historyStartsAt: Date.UTC(2023, 7, 12),
    historyStartsLate: true,
    alternateUrls: [],
    ...fields,
  })!;

test("the coverage fields parse, and odd entries are dropped", () => {
  const result = parseWaybackAppImportResult({
    imported: 1,
    lookupUrl: "https://apps.apple.com/us/app/x/id42",
    historyStartsAt: 1_700_000_000_000,
    historyStartsLate: true,
    alternateUrls: ["https://apps.apple.com/us/app/old/id42", 7, "", null],
  })!;
  assert.equal(result.lookupUrl, "https://apps.apple.com/us/app/x/id42");
  assert.equal(result.historyStartsAt, 1_700_000_000_000);
  assert.equal(result.historyStartsLate, true);
  assert.deepEqual(result.alternateUrls, [
    "https://apps.apple.com/us/app/old/id42",
  ]);
  // Absent (Node, or a route from before coverage): all unknown.
  const before = parseWaybackAppImportResult({ imported: 1 })!;
  assert.equal(before.lookupUrl, null);
  assert.equal(before.historyStartsAt, null);
  assert.equal(before.historyStartsLate, null);
  assert.equal(before.alternateUrls, null);
  const odd = parseWaybackAppImportResult({
    historyStartsLate: "yes",
    alternateUrls: "https://apps.apple.com/us/app/old/id42",
    lookupUrl: 5,
  })!;
  assert.equal(odd.historyStartsLate, null);
  assert.equal(odd.alternateUrls, null);
  assert.equal(odd.lookupUrl, null);
});

test("a late start offers an older address, dated by the server", () => {
  const startsAt = Date.UTC(2023, 9, 1);
  const outcome = describeWaybackAppImport(p5({ historyStartsAt: startsAt }));
  assert.deepEqual(outcome.notes[0], {
    key: "note_starts_on",
    values: { dateMs: startsAt },
  });
  assert.deepEqual(outcome.alternates, { late: true, urls: [], canAdd: true });
});

test("the server's verdict wins over the first capture", () => {
  // Released in 2023: history starting then is not late.
  const onTime = describeWaybackAppImport(p5({ historyStartsLate: false }));
  assert.equal(
    onTime.notes.some((n) => n.key === "note_starts_on"),
    false
  );
  assert.equal(onTime.alternates, null);
  // A late start the first capture alone would not show.
  const late = describeWaybackAppImport(
    p5({
      firstCaptureMs: WAYBACK_HISTORY_FLOOR_MS + DAY,
      historyStartsAt: WAYBACK_HISTORY_FLOOR_MS + DAY,
      historyStartsLate: true,
    })
  );
  assert.equal(late.notes[0]?.key, "note_starts_on");
});

test("stored addresses stay listed, and three is the most", () => {
  const old = "https://apps.apple.com/us/app/old-name/id42";
  // An older address fixed the late start: list it, offer nothing more.
  assert.deepEqual(
    describeWaybackAppImport(
      p5({ historyStartsLate: false, alternateUrls: [old] })
    ).alternates,
    { late: false, urls: [old], canAdd: false }
  );
  const three = [old, `${old}?x=1`, "https://apps.apple.com/gb/app/a/id42"];
  assert.deepEqual(
    describeWaybackAppImport(p5({ alternateUrls: three })).alternates,
    { late: true, urls: three, canAdd: false }
  );
  // Nothing archived under any address: the list stays removable.
  assert.deepEqual(
    describeWaybackAppImport(
      p5({
        changes: 0,
        reads: 0,
        labelVersions: 0,
        imported: 0,
        unchanged: 0,
        firstCaptureMs: null,
        lastCaptureMs: null,
        historyStartsAt: null,
        historyStartsLate: false,
        alternateUrls: [old],
      })
    ),
    {
      alternates: { late: false, urls: [old], canAdd: false },
      headline: { key: "result_no_archive" },
      notes: [],
      rowsAdded: 0,
    }
  );
});
