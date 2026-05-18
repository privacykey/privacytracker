import type { Meta, StoryObj } from "@storybook/nextjs";
import { useEffect } from "react";
import AboutModal, { openAboutModal } from "./AboutModal";

const meta = {
  title: "I/AboutModal",
  component: AboutModal,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "macOS-style About dialog. Opens via the imperative " +
          "`openAboutModal()` event. The Closed story renders nothing; the " +
          "Open story dispatches the event on mount so the modal is visible.",
      },
    },
  },
} satisfies Meta<typeof AboutModal>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

function AutoOpen() {
  useEffect(() => {
    openAboutModal();
  }, []);
  return <AboutModal />;
}

export const Open: Story = {
  render: () => <AutoOpen />,
};

export const OpenChinese: Story = {
  globals: { locale: "zh" },
  render: () => <AutoOpen />,
};
