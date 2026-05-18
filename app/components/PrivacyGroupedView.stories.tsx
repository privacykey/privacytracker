import type { Meta, StoryObj } from "@storybook/nextjs";
import PrivacyGroupedView from "./PrivacyGroupedView";

const SAMPLE_DATA = [
  {
    identifier: "DATA_USED_TO_TRACK_YOU",
    title: "Data Used to Track You",
    detail: "Data collected and linked with third-party data for targeted ads.",
    categories: [
      {
        identifier: "IDENTIFIERS",
        title: "Identifiers",
        riskWeight: 3,
        apps: [
          { id: "389801252", name: "Instagram" },
          { id: "597397889", name: "Telegram" },
        ],
      },
      {
        identifier: "USAGE_DATA",
        title: "Usage Data",
        riskWeight: 2,
        apps: [{ id: "284882215", name: "Facebook" }],
      },
    ],
  },
  {
    identifier: "DATA_LINKED_TO_YOU",
    title: "Data Linked to You",
    detail: "Data tied to your identity via account or device.",
    categories: [
      {
        identifier: "CONTACT_INFO",
        title: "Contact Info",
        apps: [
          { id: "389801252", name: "Instagram" },
          { id: "284882215", name: "Facebook" },
          { id: "324684580", name: "Spotify" },
        ],
      },
      {
        identifier: "LOCATION",
        title: "Location",
        apps: [{ id: "284882215", name: "Facebook" }],
      },
    ],
  },
  {
    identifier: "DATA_NOT_LINKED_TO_YOU",
    title: "Data Not Linked to You",
    detail: "Anonymised or aggregated data.",
    categories: [
      {
        identifier: "DIAGNOSTICS",
        title: "Diagnostics",
        apps: [
          { id: "281796108", name: "Apple Music" },
          { id: "1611158928", name: "ChatGPT" },
        ],
      },
    ],
  },
];

const meta: Meta<typeof PrivacyGroupedView> = {
  title: "I/PrivacyGroupedView",
  component: PrivacyGroupedView,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof PrivacyGroupedView>;

export const Default: Story = {
  args: { initialData: SAMPLE_DATA },
};

export const Empty: Story = {
  args: { initialData: [] },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
  args: { initialData: SAMPLE_DATA },
};
