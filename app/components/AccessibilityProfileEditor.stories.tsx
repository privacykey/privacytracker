import type { Meta, StoryObj } from "@storybook/nextjs";
import { useState } from "react";
import type { AccessibilityProfile } from "../../lib/accessibility-profile";
import AccessibilityProfileEditor from "./AccessibilityProfileEditor";

function StatefulEditor({
  initial,
  disabled,
}: {
  initial: AccessibilityProfile;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<AccessibilityProfile>(initial);
  return (
    <AccessibilityProfileEditor
      disabled={disabled}
      onChange={setValue}
      value={value}
    />
  );
}

const SAMPLE_PROFILE: AccessibilityProfile = {
  voiceover: "required",
  larger_text: "required",
  captions: "required",
  voice_control: "nice",
  dark_interface: "nice",
};

const meta: Meta<typeof AccessibilityProfileEditor> = {
  title: "I/AccessibilityProfileEditor",
  component: AccessibilityProfileEditor,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof AccessibilityProfileEditor>;

export const Empty: Story = {
  render: () => <StatefulEditor initial={{}} />,
};

export const Partial: Story = {
  render: () => <StatefulEditor initial={SAMPLE_PROFILE} />,
};

export const Disabled: Story = {
  render: () => <StatefulEditor disabled initial={SAMPLE_PROFILE} />,
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
  render: () => <StatefulEditor initial={SAMPLE_PROFILE} />,
};
