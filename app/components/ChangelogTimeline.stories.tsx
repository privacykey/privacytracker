import type { Meta, StoryObj } from "@storybook/nextjs";
import type { ChangelogRow } from "../../lib/changelog-types";
import ChangelogTimeline from "./ChangelogTimeline";

const NOW = Date.now();
const DAY = 1000 * 60 * 60 * 24;

const SAMPLE_ROWS: ChangelogRow[] = [
  {
    kind: "snapshot",
    id: "snap-1",
    scraped_at: NOW - 2 * DAY,
    app_version: "7.22.0",
    app_version_updated_at: NOW - 3 * DAY,
    changes_detected: 2,
    changes_summary: [
      {
        type: "added",
        category: "privacy-label",
        description: "Added Usage Data under Data Linked to You",
      },
      {
        type: "removed",
        category: "privacy-label",
        description: "Removed Identifiers from Data Used to Track You",
      },
    ],
    source: "live",
    triggered_by: "scheduled",
  },
  {
    kind: "review",
    id: "review-1",
    action: "reviewed",
    scraped_at: NOW - 1 * DAY,
    note: "Saw the new Usage Data linkage — confirmed it's used for the in-app stats page.",
    covered_count: 2,
    covered_snapshot_ids: ["snap-1"],
    snooze_until: null,
  },
  {
    kind: "snapshot",
    id: "snap-2",
    scraped_at: NOW - 90 * DAY,
    app_version: "7.0.0",
    app_version_updated_at: NOW - 91 * DAY,
    changes_detected: 0,
    changes_summary: [],
    source: "wayback",
    matches_live_sync: true,
    triggered_by: "wayback",
  },
];

const meta: Meta<typeof ChangelogTimeline> = {
  title: "I/ChangelogTimeline",
  component: ChangelogTimeline,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof ChangelogTimeline>;

export const Default: Story = {
  args: { rows: SAMPLE_ROWS, defaultShowImported: true },
};

export const NoWayback: Story = {
  args: {
    rows: SAMPLE_ROWS.filter(
      (r) => !(r.kind === "snapshot" && r.source === "wayback")
    ),
  },
};

export const Empty: Story = {
  args: { rows: [] },
};

/**
 * Fourteen daily checks that found nothing, one of them a failed policy
 * fetch, between two label changes. The run folds into one red row
 * (lib/timeline-fold.ts) that opens on click, while the changes, the
 * lone quiet check and the first scan below keep their own cards.
 */
const QUIET_RUN_ROWS: ChangelogRow[] = [
  SAMPLE_ROWS[0],
  ...Array.from({ length: 14 }, (_, i): ChangelogRow => {
    const common = {
      kind: "snapshot" as const,
      id: `quiet-${i}`,
      scraped_at: NOW - (3 + i) * DAY,
      changes_detected: 0,
      source: "live" as const,
    };
    if (i === 5) {
      return {
        ...common,
        changes_summary: [
          {
            type: "policy",
            category: "privacy-policy",
            description: "Privacy policy rescrape failed",
            policy_event: "error",
          },
        ],
        triggered_by: null,
      };
    }
    return {
      ...common,
      app_version: "7.22.0",
      changes_summary: [],
      triggered_by: "scheduled",
    };
  }),
  {
    kind: "snapshot",
    id: "snap-older-change",
    scraped_at: NOW - 20 * DAY,
    changes_detected: 1,
    changes_summary: [
      {
        type: "added",
        category: "privacy-label",
        description: "Added Location under Data Used to Track You",
      },
    ],
    source: "live",
    triggered_by: "scheduled",
  },
  {
    kind: "snapshot",
    id: "snap-lone-quiet",
    scraped_at: NOW - 24 * DAY,
    changes_detected: 0,
    changes_summary: [],
    source: "live",
    triggered_by: "scheduled",
  },
  {
    kind: "snapshot",
    id: "snap-first-scan",
    scraped_at: NOW - 30 * DAY,
    app_version: "7.0.0",
    changes_detected: 0,
    changes_summary: [],
    source: "live",
    triggered_by: "import",
  },
];

export const QuietRuns: Story = {
  args: { rows: QUIET_RUN_ROWS, defaultShowImported: true },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
  args: { rows: SAMPLE_ROWS },
};

// The change-finding import stores the last archived copy with the old
// labels and the first with the new ones; the change row says the change
// happened between the two.
const WAYBACK_CHANGE_ROWS: ChangelogRow[] = [
  {
    kind: "snapshot",
    id: "wb-change",
    scraped_at: NOW - 400 * DAY,
    app_version: "6.4.0",
    changes_detected: 1,
    changes_summary: [
      {
        type: "added",
        category: "privacy-label",
        description: "Added Location under Data Linked to You",
      },
    ],
    source: "wayback",
    triggered_by: "wayback",
  },
  {
    kind: "snapshot",
    id: "wb-unchanged",
    scraped_at: NOW - 430 * DAY,
    app_version: "6.3.2",
    changes_detected: 0,
    changes_summary: [],
    source: "wayback",
    triggered_by: "wayback",
  },
  {
    kind: "snapshot",
    id: "wb-baseline",
    scraped_at: NOW - 900 * DAY,
    app_version: "5.0.0",
    changes_detected: 0,
    changes_summary: [],
    source: "wayback",
    triggered_by: "wayback",
  },
];

export const WaybackChangeWindow: Story = {
  args: { rows: WAYBACK_CHANGE_ROWS, defaultShowImported: true },
};
