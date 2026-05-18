import type { Meta, StoryObj } from "@storybook/nextjs";
import { useState } from "react";
import type { PrivacyProfile } from "../../lib/privacy-profile";
import PrivacyProfileEditor from "./PrivacyProfileEditor";

function StatefulEditor({
  initial,
  disabled,
  confirmOnPresetApply,
}: {
  confirmOnPresetApply?: boolean;
  disabled?: boolean;
  initial: PrivacyProfile;
}) {
  const [value, setValue] = useState<PrivacyProfile>(initial);
  return (
    <PrivacyProfileEditor
      confirmOnPresetApply={confirmOnPresetApply}
      disabled={disabled}
      onChange={setValue}
      value={value}
    />
  );
}

const STRICT_SAMPLE: PrivacyProfile = {
  CONTACT_INFO: "not_linked",
  LOCATION: "not_collected",
  HEALTH_AND_FITNESS: "not_collected",
  FINANCIAL_INFO: "not_collected",
  SENSITIVE_INFO: "not_collected",
  IDENTIFIERS: "not_linked",
  USAGE_DATA: "linked",
  DIAGNOSTICS: "linked",
};

const meta: Meta<typeof PrivacyProfileEditor> = {
  title: "I/PrivacyProfileEditor",
  component: PrivacyProfileEditor,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof PrivacyProfileEditor>;

export const Empty: Story = {
  render: () => <StatefulEditor initial={{}} />,
};

export const Strict: Story = {
  render: () => <StatefulEditor initial={STRICT_SAMPLE} />,
};

export const NoPresetConfirm: Story = {
  render: () => (
    <StatefulEditor confirmOnPresetApply={false} initial={STRICT_SAMPLE} />
  ),
};

export const Disabled: Story = {
  render: () => <StatefulEditor disabled initial={STRICT_SAMPLE} />,
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
  render: () => <StatefulEditor initial={STRICT_SAMPLE} />,
};
