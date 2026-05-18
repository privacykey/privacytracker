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

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
  args: { rows: SAMPLE_ROWS },
};
