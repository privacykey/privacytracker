import type { Meta, StoryObj } from "@storybook/nextjs";
import type { ManualApp, ManualAppSourceMeta } from "../../lib/manual-apps";
import ManualAppsView from "./ManualAppsView";

const SOURCES: ManualAppSourceMeta[] = [
  {
    value: "web_clip",
    label: "Web Clip",
    shortLabel: "WebClip",
    icon: "🌐",
    description:
      "Saved to Home Screen from Safari — runs as a wrapped web page.",
    supportsSourceUrl: true,
    sourceUrlPlaceholder: "https://example.com",
  },
  {
    value: "testflight",
    label: "TestFlight",
    shortLabel: "TestFlight",
    icon: "🧪",
    description: "Beta builds via Apple's TestFlight program.",
    supportsSourceUrl: true,
    sourceUrlPlaceholder: "https://testflight.apple.com/join/…",
  },
  {
    value: "own_build",
    label: "Own build",
    shortLabel: "Own",
    icon: "🔧",
    description: "Self-signed build deployed via Xcode or a developer profile.",
    supportsSourceUrl: false,
  },
  {
    value: "sideloaded",
    label: "Sideloaded",
    shortLabel: "Sideloaded",
    icon: "📦",
    description:
      "Installed outside the App Store via AltStore, SideStore, etc.",
    supportsSourceUrl: false,
  },
];

const SAMPLE_APPS: ManualApp[] = [
  {
    id: "m1",
    name: "Hacker News (web clip)",
    developer: null,
    source: "web_clip",
    sourceUrl: "https://news.ycombinator.com",
    privacyPolicyUrl: null,
    notes: null,
    firstSeen: Date.now() - 1000 * 60 * 60 * 24 * 30,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
  },
  {
    id: "m2",
    name: "Beta Reader",
    developer: "Indie Dev Co.",
    source: "testflight",
    sourceUrl: "https://testflight.apple.com/join/abcdef",
    privacyPolicyUrl: "https://example.com/privacy",
    notes: "Tracking the beta cohort while they finalise the privacy policy.",
    firstSeen: Date.now() - 1000 * 60 * 60 * 24 * 14,
    updatedAt: Date.now() - 1000 * 60 * 60 * 6,
  },
  {
    id: "m3",
    name: "Dev Build (Xcode)",
    developer: null,
    source: "own_build",
    sourceUrl: null,
    privacyPolicyUrl: null,
    notes: null,
    firstSeen: Date.now() - 1000 * 60 * 60 * 24 * 90,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 5,
  },
];

const meta: Meta<typeof ManualAppsView> = {
  title: "I/ManualAppsView",
  component: ManualAppsView,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof ManualAppsView>;

export const Populated: Story = {
  args: { initialApps: SAMPLE_APPS, sources: SOURCES },
};

export const Empty: Story = {
  args: { initialApps: [], sources: SOURCES },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
  args: { initialApps: SAMPLE_APPS, sources: SOURCES },
};
