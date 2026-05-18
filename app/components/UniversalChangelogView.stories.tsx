import type { Meta, StoryObj } from "@storybook/nextjs";
import UniversalChangelogView from "./UniversalChangelogView";

const APPS = [
  { id: "281796108", name: "Apple Music" },
  { id: "389801252", name: "Instagram" },
  { id: "297606951", name: "Amazon" },
  { id: "324684580", name: "Spotify" },
  { id: "1611158928", name: "ChatGPT" },
];

const meta: Meta<typeof UniversalChangelogView> = {
  title: "I/UniversalChangelogView",
  component: UniversalChangelogView,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Universal changelog feed. Fetches `/api/changelog` on mount and " +
          "filters in-component. In Storybook the fetch fails (no backend), " +
          "so this story documents the loading/empty state with the filter " +
          "chrome rendered.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof UniversalChangelogView>;

export const Default: Story = {
  args: { apps: APPS },
};

export const SingleApp: Story = {
  args: { apps: [APPS[0]] },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
  args: { apps: APPS },
};
