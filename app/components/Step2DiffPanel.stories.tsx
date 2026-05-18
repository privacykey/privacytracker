import type { Meta, StoryObj } from "@storybook/nextjs";
import Step2DiffPanel from "./Step2DiffPanel";

const SAMPLE_ENTRIES = [
  { id: "instagram", name: "Instagram", bundleId: "com.burbn.instagram" },
  { id: "whatsapp", name: "WhatsApp", bundleId: "net.whatsapp.WhatsApp" },
  { id: "spotify", name: "Spotify", bundleId: "com.spotify.client" },
  { id: "tiktok", name: "TikTok", bundleId: "com.zhiliaoapp.musically" },
  { id: "gmail", name: "Gmail", bundleId: "com.google.Gmail" },
];

const meta = {
  title: "I/Step2DiffPanel",
  component: Step2DiffPanel,
  parameters: { layout: "padded" },
  args: {
    deviceId: "device-stub",
    deviceName: "My iPhone",
    entries: SAMPLE_ENTRIES,
    onConfirm: (selection) => {
      // eslint-disable-next-line no-console
      console.log("Step2DiffPanel.onConfirm", selection);
    },
  },
} satisfies Meta<typeof Step2DiffPanel>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const EmptyEntries: Story = {
  args: { entries: [] },
};
