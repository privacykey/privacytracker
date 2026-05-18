import type { Meta, StoryObj } from "@storybook/nextjs";
import BackgroundModeWizard from "./BackgroundModeWizard";

const meta: Meta<typeof BackgroundModeWizard> = {
  title: "I/BackgroundModeWizard",
  component: BackgroundModeWizard,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Tauri-only setup wizard for keep-running-in-background mode. " +
          "Story passes initial config so the wizard renders a populated state. " +
          "In the web/Storybook build the Tauri IPC calls fail silently — the " +
          "wizard UI still walks through its steps.",
      },
    },
  },
  args: {
    onClose: (outcome: "completed" | "dismissed") => {
      // eslint-disable-next-line no-console
      console.log("BackgroundModeWizard.onClose", outcome);
    },
  },
};
export default meta;

type Story = StoryObj<typeof BackgroundModeWizard>;

export const FreshSetup: Story = {};

export const ReturningUser: Story = {
  args: {
    initial: {
      autostart: true,
      launchHidden: true,
      nativeNotifications: true,
      sync: "daily",
      quietHoursEnabled: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      webhookUrl: "",
      webhookFormat: "slack",
      webhookFrequency: "immediate",
    },
  },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};
