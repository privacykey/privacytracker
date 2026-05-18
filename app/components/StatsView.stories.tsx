import type { Meta, StoryObj } from "@storybook/nextjs";
import type { StatsData } from "../../lib/stats";
import StatsView from "./StatsView";

const SAMPLE_STATS: StatsData = {
  totalApps: 87,
  totalCategories: 412,
  totalUniqueCategories: 12,
  totalSyncs: 1543,
  appsWithChanges: 14,
  staleApps: 9,
  appsNotMatchingProfile: 6,
  appsWithAccessibilityLabels: 52,
  appsEvaluatedForAccessibility: 78,
  profileActive: true,
  categoryFrequency: [
    { identifier: "IDENTIFIERS", title: "Identifiers", appCount: 62 },
    { identifier: "USAGE_DATA", title: "Usage Data", appCount: 58 },
    { identifier: "DIAGNOSTICS", title: "Diagnostics", appCount: 54 },
    { identifier: "CONTACT_INFO", title: "Contact Info", appCount: 31 },
    { identifier: "USER_CONTENT", title: "User Content", appCount: 24 },
    { identifier: "LOCATION", title: "Location", appCount: 19 },
    { identifier: "PURCHASES", title: "Purchases", appCount: 11 },
    { identifier: "SEARCH_HISTORY", title: "Search History", appCount: 8 },
  ],
  accessibilityFeatureFrequency: [
    { identifier: "voiceover", title: "VoiceOver", appCount: 41 },
    { identifier: "larger_text", title: "Larger Text", appCount: 38 },
    {
      identifier: "sufficient_contrast",
      title: "Sufficient Contrast",
      appCount: 34,
    },
    { identifier: "captions", title: "Captions", appCount: 12 },
    { identifier: "voice_control", title: "Voice Control", appCount: 9 },
    {
      identifier: "dark_interface",
      title: "Dark Interface",
      appCount: 47,
    },
  ],
  recentChanges: [],
  staleAppsList: [],
};

const EMPTY_STATS: StatsData = {
  totalApps: 0,
  totalCategories: 0,
  totalUniqueCategories: 0,
  totalSyncs: 0,
  appsWithChanges: 0,
  staleApps: 0,
  appsNotMatchingProfile: 0,
  appsWithAccessibilityLabels: 0,
  appsEvaluatedForAccessibility: 0,
  profileActive: false,
  categoryFrequency: [],
  accessibilityFeatureFrequency: [],
  recentChanges: [],
  staleAppsList: [],
};

const meta: Meta<typeof StatsView> = {
  title: "I/StatsView",
  component: StatsView,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof StatsView>;

export const Populated: Story = {
  args: { stats: SAMPLE_STATS, trackAccessibility: true },
};

export const NoProfile: Story = {
  args: {
    stats: { ...SAMPLE_STATS, profileActive: false, appsNotMatchingProfile: 0 },
    trackAccessibility: true,
  },
};

export const AccessibilityOff: Story = {
  args: { stats: SAMPLE_STATS, trackAccessibility: false },
};

export const Empty: Story = {
  args: { stats: EMPTY_STATS, trackAccessibility: true },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
  args: { stats: SAMPLE_STATS, trackAccessibility: true },
};
