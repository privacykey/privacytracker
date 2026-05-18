import type { Meta, StoryObj } from "@storybook/nextjs";
import DevicesView, { type DeviceListEntry } from "./DevicesView";

const NOW = Date.now();
const DAY = 1000 * 60 * 60 * 24;

const SAMPLE_DEVICES: DeviceListEntry[] = [
  {
    id: "device-1",
    ecid: "00008110-001A0D1A0220801E",
    name: "Sam's iPhone",
    model: "iPhone 15 Pro",
    iosVersion: "26.4.1",
    deviceClass: "iPhone",
    appCount: 87,
    createdAt: NOW - 30 * DAY,
    lastSyncedAt: NOW - 2 * DAY,
    isUnknownPlaceholder: false,
  },
  {
    id: "device-2",
    ecid: "00008120-001A4F2C3D0F0021",
    name: "Sam's iPad",
    model: "iPad Pro 11-inch",
    iosVersion: "26.3.0",
    deviceClass: "iPad",
    appCount: 42,
    createdAt: NOW - 60 * DAY,
    lastSyncedAt: NOW - 7 * DAY,
    isUnknownPlaceholder: false,
  },
  {
    id: "device-unknown",
    ecid: null,
    name: "Unknown device",
    model: null,
    iosVersion: null,
    deviceClass: null,
    appCount: 5,
    createdAt: NOW - 90 * DAY,
    lastSyncedAt: NOW - 60 * DAY,
    isUnknownPlaceholder: true,
  },
];

const meta: Meta<typeof DevicesView> = {
  title: "I/DevicesView",
  component: DevicesView,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof DevicesView>;

export const Populated: Story = {
  args: { initialDevices: SAMPLE_DEVICES },
};

export const SingleDevice: Story = {
  args: { initialDevices: [SAMPLE_DEVICES[0]] },
};

export const UnknownOnly: Story = {
  args: { initialDevices: [SAMPLE_DEVICES[2]] },
};

export const Empty: Story = {
  args: { initialDevices: [] },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
  args: { initialDevices: SAMPLE_DEVICES },
};
