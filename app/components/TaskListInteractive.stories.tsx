import type { Meta, StoryObj } from "@storybook/nextjs";
import type { OptInCandidate, ResolvedTask } from "../../lib/tasks";
import TaskListInteractive from "./TaskListInteractive";
import { UserTasksProvider } from "./UserTasksProvider";

const SAMPLE_TASKS: ResolvedTask[] = [
  {
    id: "view_privacy_map",
    i18nKey: "tasks.view_privacy_map",
    audience: "self",
    state: "completed",
    prerequisites: [],
    route: "/dashboard/privacy",
    startedAt: Date.now() - 1000 * 60 * 60 * 24,
    dismissedAt: null,
    optedInAt: null,
  },
  {
    id: "open_any_app_detail",
    i18nKey: "tasks.open_any_app_detail",
    audience: "self",
    state: "in_progress",
    prerequisites: [],
    route: "/dashboard/apps",
    startedAt: Date.now() - 1000 * 60 * 60 * 6,
    dismissedAt: null,
    optedInAt: null,
  },
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
    id: "review_mismatches",
    i18nKey: "tasks.review_mismatches",
    audience: "self",
    state: "blocked",
    prerequisites: ["create_privacy_profile"],
    route: "/dashboard/apps?filter=mismatch",
    startedAt: null,
    dismissedAt: null,
    optedInAt: null,
  },
];

const SAMPLE_CANDIDATES: OptInCandidate[] = [];

const meta: Meta<typeof TaskListInteractive> = {
  title: "I/TaskListInteractive",
  component: TaskListInteractive,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <UserTasksProvider initialTasks={SAMPLE_TASKS}>
        <Story />
      </UserTasksProvider>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof TaskListInteractive>;

export const SelfAudience: Story = {
  args: {
    audience: "self",
    initialTasks: SAMPLE_TASKS,
    initialCandidates: SAMPLE_CANDIDATES,
    visibleRows: SAMPLE_TASKS,
  },
};

export const GuardianAudience: Story = {
  args: {
    audience: "guardian",
    initialTasks: SAMPLE_TASKS.map((t) => ({ ...t, audience: "guardian" })),
    initialCandidates: SAMPLE_CANDIDATES,
    visibleRows: SAMPLE_TASKS.map((t) => ({ ...t, audience: "guardian" })),
  },
};

export const EmptyState: Story = {
  args: {
    audience: "self",
    initialTasks: [],
    initialCandidates: SAMPLE_CANDIDATES,
    visibleRows: [],
  },
};
