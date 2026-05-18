import type { Meta, StoryObj } from "@storybook/nextjs";
import AlreadyTrackedAccordion from "./AlreadyTrackedAccordion";

const SAMPLE_ENTRIES = [
  { id: "apple-music", name: "Apple Music", bundleId: "com.apple.Music" },
  { id: "instagram", name: "Instagram", bundleId: "com.burbn.instagram" },
  { id: "whatsapp", name: "WhatsApp", bundleId: "net.whatsapp.WhatsApp" },
  { id: "spotify", name: "Spotify", bundleId: "com.spotify.client" },
  { id: "duolingo", name: "Duolingo", bundleId: "com.duolingo.DuolingoMobile" },
];

const meta = {
  title: "I/AlreadyTrackedAccordion",
  component: AlreadyTrackedAccordion,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "When `deviceId` is null the component skips its `/api/devices/.../bundles` " +
          "fetch and renders nothing. Stories below pass `deviceId={null}` so we " +
          "preview the static markup paths without a network mock.",
      },
    },
  },
  args: {
    deviceId: null,
    deviceName: "My iPhone",
    entries: SAMPLE_ENTRIES,
  },
} satisfies Meta<typeof AlreadyTrackedAccordion>;
export default meta;

type Story = StoryObj<typeof meta>;

export const NullDevice: Story = {};

export const EmptyEntries: Story = {
  args: { entries: [] },
};
