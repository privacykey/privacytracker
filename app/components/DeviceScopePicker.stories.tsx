import type { Meta, StoryObj } from "@storybook/nextjs";
import type { DeviceScope } from "@/lib/device-scope";
import { SCOPE_ALL } from "@/lib/device-scope";
import DeviceScopePicker from "./DeviceScopePicker";
import {
  DeviceScopeStoryProvider,
  type ScopeDeviceEntry,
} from "./DeviceScopeProvider";

/**
 * The nav's device picker. Stories drive it through
 * `DeviceScopeStoryProvider` rather than the real one so no fetch is
 * involved and each state is reachable directly.
 *
 * The picker renders null when there is nothing to choose between, so a
 * single-device install has no story — that IS the behaviour.
 */

const DEVICES: ScopeDeviceEntry[] = [
  {
    appCount: 84,
    deviceClass: "iPhone",
    id: "dev-phone",
    model: "iPhone15,2",
    name: "My iPhone",
  },
  {
    appCount: 31,
    deviceClass: "iPad",
    id: "dev-tablet",
    model: "iPad13,4",
    name: "Mum's iPad",
  },
  {
    appCount: 12,
    deviceClass: null,
    id: "dev-watch",
    model: "Watch6,1",
    name: "Dad's Watch",
  },
];

const subset = (ids: string[], unattached = false): DeviceScope => ({
  v: 1,
  mode: "subset",
  deviceIds: ids,
  includeUnattached: unattached,
});

const meta: Meta<typeof DeviceScopePicker> = {
  title: "Nav/DeviceScopePicker",
  component: DeviceScopePicker,
  parameters: { layout: "centered" },
};
export default meta;

type Story = StoryObj<typeof DeviceScopePicker>;

/** Default: nothing narrowed, so the trigger reads "All devices". */
export const AllDevices: Story = {
  render: () => (
    <DeviceScopeStoryProvider devices={DEVICES} scope={SCOPE_ALL}>
      <DeviceScopePicker />
    </DeviceScopeStoryProvider>
  ),
};

/**
 * The case the feature exists for — the trigger answers "whose phone am
 * I looking at?" with an icon and a name, not a count.
 */
export const SingleDevice: Story = {
  render: () => (
    <DeviceScopeStoryProvider devices={DEVICES} scope={subset(["dev-tablet"])}>
      <DeviceScopePicker />
    </DeviceScopeStoryProvider>
  ),
};

/** Two of three picked — the multi label, with the scoped border. */
export const TwoOfThree: Story = {
  render: () => (
    <DeviceScopeStoryProvider
      devices={DEVICES}
      scope={subset(["dev-phone", "dev-tablet"])}
    >
      <DeviceScopePicker />
    </DeviceScopeStoryProvider>
  ),
};

/** Only the apps that never came from a device (manual + CSV imports). */
export const UnattachedOnly: Story = {
  render: () => (
    <DeviceScopeStoryProvider devices={DEVICES} scope={subset([], true)}>
      <DeviceScopePicker />
    </DeviceScopeStoryProvider>
  ),
};

/** The nav's `compact` width tier drops the text label. */
export const Compact: Story = {
  render: () => (
    <DeviceScopeStoryProvider devices={DEVICES} scope={subset(["dev-phone"])}>
      <DeviceScopePicker compact />
    </DeviceScopeStoryProvider>
  ),
};
