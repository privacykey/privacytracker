import type { Meta, StoryObj } from "@storybook/nextjs";
import type { ResolvedTask } from "../../lib/tasks";
import TaskListIcon from "./TaskListIcon";
import { UserTasksProvider } from "./UserTasksProvider";

const READY_TASKS: ResolvedTask[] = [
  {
    id: "create_privacy_profile",
    i18nKey: "tasks.create_privacy_profile",
    audience: "self",
    state: "ready",
    prerequisites: [],
    route: "/dashboard/settings#privacy-profile",
    startedAt: null,
    dismissedAt: null,
    optedInAt: null,
  },
  {
    id: "open_any_app_detail",
    i18nKey: "tasks.open_any_app_detail",
    audience: "self",
    state: "ready",
    prerequisites: [],
    route: "/dashboard/apps",
    startedAt: null,
    dismissedAt: null,
    optedInAt: null,
  },
];

const COMPLETED_TASKS: ResolvedTask[] = READY_TASKS.map((t) => ({
  ...t,
  state: "completed",
  startedAt: Date.now() - 1000 * 60 * 60,
}));

const meta: Meta<typeof TaskListIcon> = {
  title: "I/TaskListIcon",
  component: TaskListIcon,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Nav-bar icon that shows a badge with the count of `ready` tasks. " +
          "Stories wrap the icon in a real `UserTasksProvider` seeded with sample tasks.",
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof TaskListIcon>;

export const WithReadyTasks: Story = {
  decorators: [
    (Story) => (
      <UserTasksProvider initialTasks={READY_TASKS}>
        <Story />
      </UserTasksProvider>
    ),
  ],
};

export const AllCompleted: Story = {
  decorators: [
    (Story) => (
      <UserTasksProvider initialTasks={COMPLETED_TASKS}>
        <Story />
      </UserTasksProvider>
    ),
  ],
};

export const EmptyTasks: Story = {
  decorators: [
    (Story) => (
      <UserTasksProvider initialTasks={[]}>
        <Story />
      </UserTasksProvider>
    ),
  ],
};
