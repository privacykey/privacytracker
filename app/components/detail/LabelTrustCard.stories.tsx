import type { Meta, StoryObj } from "@storybook/nextjs";
import type {
  ChangelogRow,
  PrivacyTypeSnapshot,
} from "../../../lib/changelog-types";
import type { AppPolicyAnalysis } from "../../../lib/policy-summary-meta";
import LabelTrustCard from "./LabelTrustCard";
import type { App } from "./types";

// ── fixtures ──────────────────────────────────────────────────────────

const DNC = "DATA_NOT_COLLECTED";
const LINKED = "DATA_LINKED_TO_YOU";
const NOT_LINKED = "DATA_NOT_LINKED_TO_YOU";
const TRACK = "DATA_USED_TO_TRACK_YOU";

const T = {
  feb2021: Date.UTC(2021, 1, 3),
  jun2022: Date.UTC(2022, 5, 14),
  mar2024: Date.UTC(2024, 2, 9),
  jan2026: Date.UTC(2026, 0, 12),
  may2026: Date.UTC(2026, 4, 1),
};

function snapshot(...ids: string[]): string {
  const types: PrivacyTypeSnapshot[] = ids.map((identifier) => ({
    identifier,
    title: identifier,
    categories:
      identifier === DNC
        ? []
        : [{ identifier: "IDENTIFIERS", title: "Identifiers" }],
  }));
  return JSON.stringify(types);
}

let seq = 0;
function row(
  scrapedAt: number,
  overrides: Partial<Extract<ChangelogRow, { kind: "snapshot" }>> = {}
): ChangelogRow {
  seq += 1;
  return {
    id: `story-row-${seq}`,
    kind: "snapshot",
    scraped_at: scrapedAt,
    changes_detected: 0,
    changes_summary: [],
    source: "live",
    ...overrides,
  };
}

function app(overrides: Partial<App>): App {
  return {
    id: "1000000001",
    name: "Example App",
    url: "https://apps.apple.com/app/id1000000001",
    firstSeen: T.jan2026,
    lastSynced: T.may2026,
    changeCount: 0,
    syncCount: 12,
    privacyTypes: [],
    ...overrides,
  };
}

function policy(
  ratings: Partial<
    Record<
      | "collection_scope"
      | "tracking_analytics"
      | "ads_marketing"
      | "third_party_sharing",
      "favorable" | "mixed" | "concerning" | "unclear"
    >
  >
): AppPolicyAnalysis {
  return {
    status: "ready",
    sourceWordCount: 2400,
    sourceLength: 15_000,
    updatedAt: T.may2026,
    summary: {
      overview: "",
      highlights: [],
      lenses: Object.entries(ratings).map(([key, rating]) => ({
        key: key as keyof typeof ratings,
        rating,
        summary: "",
      })),
    },
  };
}

// ── meta ──────────────────────────────────────────────────────────────

const meta: Meta<typeof LabelTrustCard> = {
  title: "Detail/LabelTrustCard",
  component: LabelTrustCard,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "'How much to trust this label' — the reading aid at the top of the " +
          "Privacy Labels tab. Each row is a finding from Alsahdi et al. " +
          "(PoPETs 2026) applied to the app: label age, a 'Data Not Collected' " +
          "label, the policy-lens cross-check, and the pricing model. Gated by " +
          "`flag.detail.labels.trust_card` (Monitor goal). Stories pass " +
          "`changelogHasMore: false` so nothing is fetched.",
      },
    },
  },
  args: {
    changelogHasMore: false,
    onOpenHistory: () => {},
    onOpenPolicy: () => {},
  },
};
export default meta;

type Story = StoryObj<typeof LabelTrustCard>;

/**
 * The shape the study trusts least: "Data Not Collected", unchanged since a
 * 2021 archive capture (so it also predates privacy manifests), free with
 * in-app purchases, and a policy whose ads and tracking lenses say more
 * than the label does.
 */
export const LeastTrusted: Story = {
  args: {
    app: app({
      name: "Free Puzzle Quest",
      privacyTypes: [
        {
          id: "t1",
          identifier: DNC,
          title: "Data Not Collected",
          categories: [],
        },
      ],
      priceAmount: 0,
      priceCurrency: "USD",
      priceFormatted: "Free",
      hasIap: 1,
      policyAnalysis: policy({
        collection_scope: "mixed",
        tracking_analytics: "concerning",
        ads_marketing: "concerning",
        third_party_sharing: "unclear",
      }),
    }),
    changelog: [
      row(T.may2026, { snapshot_json: snapshot(DNC) }),
      row(T.jan2026, { triggered_by: "import", snapshot_json: snapshot(DNC) }),
      row(T.jun2022, { source: "wayback", snapshot_json: snapshot(DNC) }),
      row(T.feb2021, { source: "wayback", snapshot_json: snapshot(DNC) }),
    ],
  },
};

/**
 * A label that was updated in 2024 to add "Data Used to Track You", a
 * paid app, and a policy that agrees with it. Three reassuring rows.
 */
export const UpdatedAndConsistent: Story = {
  args: {
    app: app({
      name: "Weather Pro",
      privacyTypes: [
        {
          id: "t1",
          identifier: NOT_LINKED,
          title: "Data Not Linked to You",
          categories: [],
        },
        {
          id: "t2",
          identifier: TRACK,
          title: "Data Used to Track You",
          categories: [],
        },
      ],
      priceAmount: 4.99,
      priceCurrency: "USD",
      priceFormatted: "$4.99",
      hasIap: 0,
      policyAnalysis: policy({
        tracking_analytics: "concerning",
        ads_marketing: "mixed",
      }),
    }),
    changelog: [
      row(T.may2026, { snapshot_json: snapshot(NOT_LINKED, TRACK) }),
      row(T.mar2024, {
        changes_detected: 1,
        changes_summary: [
          {
            type: "added",
            description: 'New privacy label: "Data Used to Track You"',
          },
        ],
        snapshot_json: snapshot(NOT_LINKED, TRACK),
      }),
      row(T.jun2022, {
        source: "wayback",
        snapshot_json: snapshot(NOT_LINKED),
      }),
    ],
  },
};

/**
 * The common first-week state: a declared label, only live rows since the
 * app was added, no policy fetched yet, price unknown. The age row offers
 * the Change History tab; the policy row offers the AI Policy tab.
 */
export const JustAdded: Story = {
  args: {
    app: app({
      name: "Notes Plus",
      privacyTypes: [
        {
          id: "t1",
          identifier: LINKED,
          title: "Data Linked to You",
          categories: [],
        },
      ],
    }),
    changelog: [
      row(T.may2026, { snapshot_json: snapshot(LINKED) }),
      row(T.jan2026, {
        triggered_by: "import",
        snapshot_json: snapshot(LINKED),
      }),
    ],
  },
};

export const ChineseLocale: Story = {
  ...LeastTrusted,
  globals: { locale: "zh" },
};
