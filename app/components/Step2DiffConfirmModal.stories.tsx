import type { Meta, StoryObj } from "@storybook/nextjs";
import Step2DiffConfirmModal from "./Step2DiffConfirmModal";

const meta = {
  title: "I/Step2DiffConfirmModal",
  component: Step2DiffConfirmModal,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    busy: false,
    addCount: 6,
    removeCount: 2,
    deviceName: "My iPhone",
    onConfirm: () => {
      // eslint-disable-next-line no-console
      console.log("Step2DiffConfirmModal.onConfirm");
    },
    onBack: () => {
      // eslint-disable-next-line no-console
      console.log("Step2DiffConfirmModal.onBack");
    },
  },
} satisfies Meta<typeof Step2DiffConfirmModal>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Busy: Story = {
  args: { busy: true },
};

export const AddsOnly: Story = {
  args: { removeCount: 0 },
};

export const RemovesOnly: Story = {
  args: { addCount: 0, removeCount: 4 },
};

export const Closed: Story = {
  args: { open: false },
};
