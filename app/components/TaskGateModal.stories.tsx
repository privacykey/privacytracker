import type { Meta, StoryObj } from "@storybook/nextjs";
import type { ResolvedTask } from "../../lib/tasks";
import TaskGateModal from "./TaskGateModal";

const SAMPLE_TASK: ResolvedTask = {
  id: "review_mismatches",
  i18nKey: "tasks.review_mismatches",
  audience: "self",
  prerequisites: ["create_privacy_profile"],
  route: "/dashboard/apps?filter=mismatch",
  state: "blocked",
  startedAt: null,
  dismissedAt: null,
  optedInAt: null,
};

const meta = {
  title: "I/TaskGateModal",
  component: TaskGateModal,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    task: SAMPLE_TASK,
    prerequisiteId: "create_privacy_profile",
    onCancel: () => {
      // eslint-disable-next-line no-console
      console.log("TaskGateModal.onCancel");
    },
    onContinueAnyway: () => {
      // eslint-disable-next-line no-console
      console.log("TaskGateModal.onContinueAnyway");
    },
    onGotoPrerequisite: () => {
      // eslint-disable-next-line no-console
      console.log("TaskGateModal.onGotoPrerequisite");
    },
  },
} satisfies Meta<typeof TaskGateModal>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Closed: Story = {
  args: { open: false },
};

export const NullTask: Story = {
  args: { task: null, prerequisiteId: null },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};
