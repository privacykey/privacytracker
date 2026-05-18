import type { Meta, StoryObj } from "@storybook/nextjs";
import Nav from "./Nav";
import { TaskCenterProvider } from "./TaskCenter";
import { UserTasksProvider } from "./UserTasksProvider";

const meta: Meta<typeof Nav> = {
  title: "I/Nav",
  component: Nav,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Top navigation bar. Stories wrap the nav in the real " +
          "`TaskCenterProvider` (polling disabled) and `UserTasksProvider` " +
          "so the embedded TaskListIcon + TaskCenterTrigger + NotificationBell " +
          "have the context they need. /api/* fetches will fail silently.",
      },
    },
  },
  decorators: [
    (Story) => (
      <TaskCenterProvider
        autoDismissEnabled={false}
        pollingEnabled={false}
        resumeCardsEnabled={false}
      >
        <UserTasksProvider initialTasks={[]}>
          <Story />
        </UserTasksProvider>
      </TaskCenterProvider>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof Nav>;

export const Default: Story = {
  args: { appCount: 12 },
};

export const NoAppCount: Story = {};

export const FullFlags: Story = {
  args: {
    appCount: 87,
    flags: {
      appCountBadge: true,
      notificationBell: true,
      notificationBellPolling: false,
      taskCenterTrigger: true,
      taskListIcon: true,
      mobileDrawer: true,
      pagePrivacyMap: true,
    },
  },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
  args: { appCount: 12 },
};
