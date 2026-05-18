import type { Meta, StoryObj } from "@storybook/nextjs";
import DeviceSyncDiffOverlay from "./DeviceSyncDiffOverlay";

const SAMPLE_IMPORT = [
  {
    appId: "389801252",
    name: "Instagram",
    developer: "Instagram, Inc.",
    bundleId: "com.burbn.instagram",
  },
  {
    appId: "284882215",
    name: "Facebook",
    developer: "Meta Platforms, Inc.",
    bundleId: "com.facebook.Facebook",
  },
  {
    appId: "324684580",
    name: "Spotify",
    developer: "Spotify Ltd.",
    bundleId: "com.spotify.client",
  },
  {
    appId: "597397889",
    name: "Telegram",
    developer: "Telegram FZ-LLC",
    bundleId: "ph.telegra.Telegraph",
  },
];

const meta: Meta<typeof DeviceSyncDiffOverlay> = {
  title: "I/DeviceSyncDiffOverlay",
  component: DeviceSyncDiffOverlay,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Two-step modal that previews the add/remove diff after a device " +
          "re-sync, then commits the changes. Fetches `/api/devices/.../preview` " +
          "on open; without a backend the modal sits on the preview-loading " +
          "screen. Stories document the open/closed/empty contracts.",
      },
    },
  },
  args: {
    open: true,
    deviceId: "device-1",
    currentImport: SAMPLE_IMPORT,
    onClose: () => {
      // eslint-disable-next-line no-console
      console.log("DeviceSyncDiffOverlay.onClose");
    },
    onCommit: (result) => {
      // eslint-disable-next-line no-console
      console.log("DeviceSyncDiffOverlay.onCommit", result);
    },
  },
};
export default meta;

type Story = StoryObj<typeof DeviceSyncDiffOverlay>;

export const Default: Story = {};

export const Closed: Story = {
  args: { open: false },
};

export const EmptyImport: Story = {
  args: { currentImport: [] },
};
