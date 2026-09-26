import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ChangeEntry,
  ChangelogRow,
  PrivacyTypeSnapshot,
  SnapshotChangelogRow,
} from "../../lib/changelog-types";
import { NEW_PRIVACY_TYPE_PREFIX } from "../../lib/changelog-types";
import {
  classifyLabel,
  DATA_NOT_COLLECTED,
  DATA_USED_TO_TRACK_YOU,
  deriveLabelAge,
  deriveLabelTrust,
  deriveMonetisation,
  derivePolicyCheck,
  PRIVACY_MANIFEST_ERA_MS,
  rowRecordsLabelChange,
} from "../../lib/label-trust";
import type {
  AppPolicyAnalysis,
  PolicyLensKey,
  PolicyRating,
} from "../../lib/policy-summary-meta";

// ── fixtures ──────────────────────────────────────────────────────────

const LINKED = "DATA_LINKED_TO_YOU";
const NOT_LINKED = "DATA_NOT_LINKED_TO_YOU";

function snapshot(...ids: string[]): PrivacyTypeSnapshot[] {
  return ids.map((identifier) => ({
    identifier,
    title: identifier,
    categories: [{ identifier: "IDENTIFIERS", title: "Identifiers" }],
  }));
}

let seq = 0;
function row(
  scrapedAt: number,
  overrides: Partial<SnapshotChangelogRow> = {}
): SnapshotChangelogRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    kind: "snapshot",
    scraped_at: scrapedAt,
    changes_detected: 0,
    changes_summary: [],
    source: "live",
    ...overrides,
  };
}

const added = (description: string, extra: Partial<ChangeEntry> = {}) =>
  ({ type: "added", description, ...extra }) as ChangeEntry;

const T = {
  jan2021: Date.UTC(2021, 0, 15),
  jun2022: Date.UTC(2022, 5, 1),
  mar2024: Date.UTC(2024, 2, 1),
  jan2025: Date.UTC(2025, 0, 1),
  sep2026: Date.UTC(2026, 8, 1),
};

function analysisWith(
  ratings: Partial<Record<PolicyLensKey, PolicyRating>>,
  overrides: Partial<AppPolicyAnalysis> = {}
): AppPolicyAnalysis {
  return {
    status: "ready",
    sourceWordCount: 1200,
    sourceLength: 8000,
    updatedAt: T.jan2025,
    summary: {
      overview: "",
      highlights: [],
      lenses: (Object.entries(ratings) as [PolicyLensKey, PolicyRating][]).map(
        ([key, rating]) => ({ key, rating, summary: "" })
      ),
    },
    ...overrides,
  };
}

// ── label kind ────────────────────────────────────────────────────────

test("classifyLabel: Data Not Collected is its own kind, an empty sheet is none", () => {
  assert.equal(classifyLabel([]), "none");
  assert.equal(
    classifyLabel([{ identifier: DATA_NOT_COLLECTED }]),
    "not_collected"
  );
  assert.equal(classifyLabel([{ identifier: LINKED }]), "declared");
});

// ── label age ─────────────────────────────────────────────────────────

test("rowRecordsLabelChange keys on the entries, not on changes_detected", () => {
  // A policy event sets changes_detected without touching the label.
  assert.equal(
    rowRecordsLabelChange(
      row(T.jan2025, {
        changes_detected: 1,
        changes_summary: [
          {
            type: "policy",
            category: "privacy-policy",
            policy_event: "changed",
            description: "Policy changed",
          },
        ],
      })
    ),
    false
  );
  // The archive bridge diff is derived at read time and carries no flag.
  assert.equal(
    rowRecordsLabelChange(
      row(T.jan2025, {
        changes_detected: 0,
        changes_summary: [added("Identifiers")],
        archive_bridge: {
          from_scraped_at: T.jan2021,
          wayback_snapshot_url: null,
        },
      })
    ),
    true
  );
});

test("deriveLabelAge: no snapshot rows is unknown", () => {
  assert.deepEqual(deriveLabelAge([], false), { kind: "unknown" });
  const reviewOnly: ChangelogRow[] = [
    {
      kind: "review",
      id: "review-1",
      action: "reviewed",
      covered_count: 1,
      note: null,
      scraped_at: T.jan2025,
      snooze_until: null,
    },
  ];
  assert.deepEqual(deriveLabelAge(reviewOnly, false), { kind: "unknown" });
});

test("deriveLabelAge: the newest label change wins and the type delta is exact from snapshot_json", () => {
  const rows: ChangelogRow[] = [
    row(T.sep2026, {
      snapshot_json: JSON.stringify(snapshot(LINKED, DATA_USED_TO_TRACK_YOU)),
    }),
    row(T.mar2024, {
      changes_detected: 1,
      changes_summary: [
        added(`${NEW_PRIVACY_TYPE_PREFIX}"Data Used to Track You"`),
      ],
      snapshot_json: JSON.stringify(snapshot(LINKED, DATA_USED_TO_TRACK_YOU)),
    }),
    row(T.jun2022, {
      changes_detected: 1,
      changes_summary: [added("Identifiers")],
      snapshot_json: JSON.stringify(snapshot(LINKED)),
    }),
    row(T.jan2021, {
      source: "wayback",
      snapshot_json: JSON.stringify(snapshot(NOT_LINKED)),
    }),
  ];
  const age = deriveLabelAge(rows, false);
  assert.equal(age.kind, "changed");
  if (age.kind !== "changed") {
    return;
  }
  assert.equal(age.at, T.mar2024);
  assert.deepEqual(age.addedTypes, [DATA_USED_TO_TRACK_YOU]);
  assert.deepEqual(age.removedTypes, []);
  assert.equal(age.addedTracking, true);
  assert.equal(age.predatesManifests, false);
});

test("deriveLabelAge: order of the input rows does not matter", () => {
  const change = row(T.jun2022, {
    changes_detected: 1,
    changes_summary: [added("Location")],
  });
  const newer = row(T.jan2025);
  const older = row(T.jan2021);
  const a = deriveLabelAge([older, change, newer], false);
  const b = deriveLabelAge([newer, change, older], false);
  assert.deepEqual(a, b);
  assert.equal(a.kind, "changed");
});

test("deriveLabelAge: without snapshot_json the tracking type is inferred from the entry description", () => {
  const rows: ChangelogRow[] = [
    row(T.jun2022, {
      changes_detected: 1,
      changes_summary: [
        added(`${NEW_PRIVACY_TYPE_PREFIX}"Data Used to Track You"`),
      ],
    }),
    row(T.jan2021),
  ];
  const age = deriveLabelAge(rows, false);
  assert.equal(age.kind, "changed");
  if (age.kind === "changed") {
    assert.equal(age.addedTracking, true);
    assert.equal(age.predatesManifests, true);
  }
});

test("deriveLabelAge: a category-only change is a change, but adds no type", () => {
  const rows: ChangelogRow[] = [
    row(T.jan2025, {
      changes_detected: 1,
      changes_summary: [added("Location")],
      snapshot_json: JSON.stringify(snapshot(LINKED)),
    }),
    row(T.jun2022, { snapshot_json: JSON.stringify(snapshot(LINKED)) }),
  ];
  const age = deriveLabelAge(rows, false);
  assert.equal(age.kind, "changed");
  if (age.kind === "changed") {
    assert.deepEqual(age.addedTypes, []);
    assert.equal(age.addedTracking, false);
  }
});

test("deriveLabelAge: unchanged across a complete history reports the oldest row and whether the archive was reached", () => {
  const live: ChangelogRow[] = [row(T.sep2026), row(T.jan2025)];
  const liveAge = deriveLabelAge(live, false);
  assert.deepEqual(liveAge, {
    kind: "unchanged",
    since: T.jan2025,
    reachesArchive: false,
    predatesManifests: false,
    rowsInspected: 2,
  });

  const archived: ChangelogRow[] = [
    ...live,
    row(T.jan2021, { source: "wayback" }),
  ];
  const archivedAge = deriveLabelAge(archived, false);
  assert.deepEqual(archivedAge, {
    kind: "unchanged",
    since: T.jan2021,
    reachesArchive: true,
    predatesManifests: true,
    rowsInspected: 3,
  });
});

test("deriveLabelAge: with older rows still on the server the answer is incomplete, never unchanged", () => {
  const rows: ChangelogRow[] = [row(T.sep2026), row(T.jan2025)];
  assert.deepEqual(deriveLabelAge(rows, true), {
    kind: "incomplete",
    rowsInspected: 2,
    oldestInspected: T.jan2025,
  });
});

test("PRIVACY_MANIFEST_ERA_MS is 1 December 2023", () => {
  assert.equal(
    new Date(PRIVACY_MANIFEST_ERA_MS).toISOString(),
    "2023-12-01T00:00:00.000Z"
  );
});

// ── policy cross-check ────────────────────────────────────────────────

test("derivePolicyCheck: nothing fetched is no_policy; text without a summary is no_summary", () => {
  const dnc = [{ identifier: DATA_NOT_COLLECTED }];
  assert.deepEqual(derivePolicyCheck("not_collected", dnc, null), {
    kind: "no_policy",
  });
  assert.deepEqual(derivePolicyCheck("not_collected", dnc, undefined), {
    kind: "no_policy",
  });
  assert.deepEqual(
    derivePolicyCheck(
      "not_collected",
      dnc,
      analysisWith(
        {},
        { status: "fetch_error", sourceLength: 0, summary: null }
      )
    ),
    { kind: "no_policy" }
  );
  assert.deepEqual(
    derivePolicyCheck(
      "not_collected",
      dnc,
      analysisWith({}, { status: "source_ready", summary: null })
    ),
    { kind: "no_summary" }
  );
  assert.deepEqual(
    derivePolicyCheck(
      "not_collected",
      dnc,
      analysisWith(
        {},
        { status: "needs_ai_config", sourceLength: 0, summary: null }
      )
    ),
    { kind: "no_summary" }
  );
});

test("derivePolicyCheck: Data Not Collected is contradicted by a mixed or concerning collection, tracking, ads or sharing lens", () => {
  const dnc = [{ identifier: DATA_NOT_COLLECTED }];
  const check = derivePolicyCheck(
    "not_collected",
    dnc,
    analysisWith({
      collection_scope: "favorable",
      tracking_analytics: "mixed",
      ads_marketing: "concerning",
      third_party_sharing: "unclear",
      user_controls: "concerning", // not a collection lens; must not count
    })
  );
  assert.deepEqual(check, {
    kind: "mismatch",
    lenses: ["tracking_analytics", "ads_marketing"],
  });

  assert.deepEqual(
    derivePolicyCheck(
      "not_collected",
      dnc,
      analysisWith({
        collection_scope: "favorable",
        tracking_analytics: "favorable",
        ads_marketing: "unclear",
        third_party_sharing: "favorable",
      })
    ),
    { kind: "consistent" }
  );
});

test("derivePolicyCheck: a label without tracking is contradicted only by a CONCERNING tracking or ads lens", () => {
  const linkedOnly = [{ identifier: LINKED }];
  assert.deepEqual(
    derivePolicyCheck(
      "declared",
      linkedOnly,
      analysisWith({ tracking_analytics: "mixed", ads_marketing: "mixed" })
    ),
    { kind: "consistent" }
  );
  assert.deepEqual(
    derivePolicyCheck(
      "declared",
      linkedOnly,
      analysisWith({
        tracking_analytics: "concerning",
        third_party_sharing: "concerning",
      })
    ),
    { kind: "mismatch", lenses: ["tracking_analytics"] }
  );
});

test("derivePolicyCheck: a label that already declares tracking has nothing left to contradict", () => {
  const tracking = [
    { identifier: LINKED },
    { identifier: DATA_USED_TO_TRACK_YOU },
  ];
  assert.deepEqual(
    derivePolicyCheck(
      "declared",
      tracking,
      analysisWith({
        tracking_analytics: "concerning",
        ads_marketing: "concerning",
      })
    ),
    { kind: "consistent" }
  );
});

// ── monetisation ──────────────────────────────────────────────────────

test("deriveMonetisation: price unknown is unknown; free splits on IAP; any price is paid", () => {
  assert.equal(deriveMonetisation(null, 1), "unknown");
  assert.equal(deriveMonetisation(undefined, undefined), "unknown");
  assert.equal(deriveMonetisation(Number.NaN, 1), "unknown");
  assert.equal(deriveMonetisation(0, 1), "free_iap");
  assert.equal(deriveMonetisation(0, 0), "free");
  assert.equal(deriveMonetisation(0, null), "free");
  assert.equal(deriveMonetisation(0.99, 1), "paid");
});

// ── report ────────────────────────────────────────────────────────────

test("deriveLabelTrust: the study's least-trusted shape (DNC, never changed, free with IAP, policy mentions ads) reports every signal", () => {
  const report = deriveLabelTrust({
    privacyTypes: [{ identifier: DATA_NOT_COLLECTED }],
    changelog: [row(T.sep2026), row(T.jan2021, { source: "wayback" })],
    changelogHasMore: false,
    policyAnalysis: analysisWith({ ads_marketing: "concerning" }),
    priceAmount: 0,
    hasIap: 1,
  });
  assert.equal(report.labelKind, "not_collected");
  assert.equal(report.age.kind, "unchanged");
  assert.equal(report.monetisation, "free_iap");
  assert.deepEqual(report.policy, {
    kind: "mismatch",
    lenses: ["ads_marketing"],
  });
});
