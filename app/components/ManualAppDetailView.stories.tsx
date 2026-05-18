import type { Meta, StoryObj } from "@storybook/nextjs";
import {
  FOCUS_SELF_MINIMAL,
  FOCUS_SELF_UNDERSTAND,
} from "../../.storybook/fixtures/focus";
import type {
  ManualAppEvent,
  ManualAppPolicyVersion,
} from "../../lib/manual-app-history";
import type { ManualApp, ManualAppSourceMeta } from "../../lib/manual-apps";
import ManualAppDetailView from "./ManualAppDetailView";

const SAMPLE_APP: ManualApp = {
  id: "manual_001",
  name: "TestFlight Beta Reader",
  developer: "Indie Dev Co.",
  source: "testflight",
  sourceUrl: "https://testflight.apple.com/join/abcdef",
  privacyPolicyUrl: "https://example.com/privacy",
  notes:
    "Beta build — privacy policy URL was pulled from the TestFlight invite.",
  firstSeen: Date.now() - 1000 * 60 * 60 * 24 * 14,
  updatedAt: Date.now() - 1000 * 60 * 60 * 6,
};

const SAMPLE_META: ManualAppSourceMeta = {
  value: "testflight",
  label: "TestFlight",
  shortLabel: "TestFlight",
  icon: "🧪",
  description: "Pre-release builds invited via Apple's beta program.",
  supportsSourceUrl: true,
  sourceUrlPlaceholder: "https://testflight.apple.com/join/…",
};

const SAMPLE_VERSION: ManualAppPolicyVersion = {
  id: "policy-v1",
  manualAppId: "manual_001",
  firstFetchedAt: Date.now() - 1000 * 60 * 60 * 24 * 14,
  lastFetchedAt: Date.now() - 1000 * 60 * 60 * 6,
  contentHash: "sha256:abc123",
  policyUrl: "https://example.com/privacy",
  sourceContentType: "text/html",
  sourceFinalUrl: "https://example.com/privacy",
  sourceOrigin: "example.com",
  sourceText:
    "We collect device identifiers for crash reports. We do not sell personal data. We retain logs for 30 days.",
  sourceTitle: "Privacy Policy — Indie Dev Co.",
  sourceWordCount: 24,
};

const SAMPLE_EVENTS: ManualAppEvent[] = [
  {
    id: "evt-1",
    manualAppId: "manual_001",
    occurredAt: Date.now() - 1000 * 60 * 60 * 6,
    type: "scrape",
    detail: null,
  },
  {
    id: "evt-2",
    manualAppId: "manual_001",
    occurredAt: Date.now() - 1000 * 60 * 60 * 24 * 7,
    type: "field_change",
    detail: null,
  },
];

const meta: Meta<typeof ManualAppDetailView> = {
  title: "F/ManualAppDetailView",
  component: ManualAppDetailView,
  parameters: {
    layout: "padded",
    focus: FOCUS_SELF_UNDERSTAND,
  },
};
export default meta;

type Story = StoryObj<typeof ManualAppDetailView>;

export const TestflightApp: Story = {
  args: {
    app: SAMPLE_APP,
    meta: SAMPLE_META,
    currentVersion: SAMPLE_VERSION,
    events: SAMPLE_EVENTS,
  },
};

export const NoPolicyVersion: Story = {
  args: {
    app: { ...SAMPLE_APP, privacyPolicyUrl: null },
    meta: SAMPLE_META,
    currentVersion: null,
    events: [SAMPLE_EVENTS[1]],
  },
};

export const MinimalFocus: Story = {
  parameters: { focus: FOCUS_SELF_MINIMAL },
  args: {
    app: SAMPLE_APP,
    meta: SAMPLE_META,
    currentVersion: SAMPLE_VERSION,
    events: SAMPLE_EVENTS,
  },
};
