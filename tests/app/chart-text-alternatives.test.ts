import assert from "node:assert/strict";
import test from "node:test";
import {
  groupAppsBySeverity,
  summariseBuckets,
  summariseSeverityFlow,
  withAriaLabel,
} from "../../lib/chart-text-alternatives";

/**
 * The data side of the ECharts text alternatives (WCAG 1.1.1). The
 * components turn these summaries into localised sentences; what is
 * pinned here is what gets said, and in which order.
 */

const SEVERITIES = [
  { identifier: "DATA_USED_TO_TRACK_YOU", label: "Used to track you" },
  { identifier: "DATA_LINKED_TO_YOU", label: "Linked to you" },
  { identifier: "DATA_NOT_LINKED_TO_YOU", label: "Not linked to you" },
];
const CATEGORIES = [
  { identifier: "LOCATION", label: "Location" },
  { identifier: "CONTACT_INFO", label: "Contact Info" },
  { identifier: "IDENTIFIERS", label: "Identifiers" },
];
const APPS = [
  { id: "1", name: "Maps" },
  { id: "2", name: "Notes" },
  { id: "3", name: "Empty" },
];
const CELLS = {
  "1": {
    IDENTIFIERS: "DATA_USED_TO_TRACK_YOU",
    LOCATION: "DATA_USED_TO_TRACK_YOU",
    CONTACT_INFO: "DATA_LINKED_TO_YOU",
  },
  "2": { CONTACT_INFO: "DATA_NOT_LINKED_TO_YOU" },
};

test("withAriaLabel enables ECharts aria with our label, keeping the caller's decal", () => {
  const out = withAriaLabel(
    { series: [], aria: { decal: { show: true } } },
    "Heatmap of 3 apps"
  );
  assert.deepEqual(out.aria, {
    decal: { show: true },
    enabled: true,
    label: { enabled: true, description: "Heatmap of 3 apps" },
  });
  // No aria at all: still switched on, and nothing else is touched.
  const bare = withAriaLabel({ series: [1] }, "Timeline");
  assert.deepEqual(bare, {
    series: [1],
    aria: { enabled: true, label: { enabled: true, description: "Timeline" } },
  });
});

test("summariseBuckets keeps only buckets and series with a value", () => {
  const out = summariseBuckets(
    ["Mar 1", "Mar 8", "Mar 15"],
    [
      { name: "Added", values: [0, 2, 0] },
      { name: "Policy", values: [0, 1, 0] },
      { name: "Removed", values: [0, 0, 3] },
    ]
  );
  assert.deepEqual(out, [
    {
      label: "Mar 8",
      items: [
        { name: "Added", value: 2 },
        { name: "Policy", value: 1 },
      ],
    },
    { label: "Mar 15", items: [{ name: "Removed", value: 3 }] },
  ]);
  assert.deepEqual(
    summariseBuckets(["Mar 1"], [{ name: "A", values: [0] }]),
    []
  );
});

test("groupAppsBySeverity follows the legend order, then the axis order", () => {
  assert.deepEqual(groupAppsBySeverity(APPS, CATEGORIES, CELLS, SEVERITIES), [
    {
      name: "Maps",
      groups: [
        {
          severity: "Used to track you",
          categories: ["Location", "Identifiers"],
        },
        { severity: "Linked to you", categories: ["Contact Info"] },
      ],
    },
    {
      name: "Notes",
      groups: [{ severity: "Not linked to you", categories: ["Contact Info"] }],
    },
    { name: "Empty", groups: [] },
  ]);
});

test("summariseSeverityFlow counts apps per severity and lists its categories", () => {
  assert.deepEqual(summariseSeverityFlow(APPS, CATEGORIES, CELLS, SEVERITIES), [
    {
      severity: "Used to track you",
      appCount: 1,
      categories: ["Location", "Identifiers"],
    },
    { severity: "Linked to you", appCount: 1, categories: ["Contact Info"] },
    {
      severity: "Not linked to you",
      appCount: 1,
      categories: ["Contact Info"],
    },
  ]);
  // A severity nothing reaches is left out, as the chart omits its node.
  assert.deepEqual(
    summariseSeverityFlow([APPS[1]], CATEGORIES, CELLS, SEVERITIES).map(
      (f) => f.severity
    ),
    ["Not linked to you"]
  );
});
