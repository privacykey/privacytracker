import type { Meta, StoryObj } from "@storybook/nextjs";
import {
  FOCUS_GUARDIAN_DECLUTTER,
  FOCUS_SELF_UNDERSTAND,
} from "../../.storybook/fixtures/focus";
import DataLabelHint from "./DataLabelHint";

const meta = {
  title: "F/DataLabelHint",
  component: DataLabelHint,
  parameters: {
    docs: {
      description: {
        component:
          "Skeuomorphic hover vignette that explains a privacy data label " +
          "in lived experience. All 14 Apple categories × 3 severities are " +
          "registered with clean-slate vignettes; unknown combinations " +
          "render nothing so callers can sprinkle the component freely. " +
          "Reads `flag.global.label_hints` (off for guardian/minimal).",
      },
    },
    focus: FOCUS_SELF_UNDERSTAND,
    layout: "centered",
  },
  args: {
    identifier: "CONTACT_INFO",
    severity: "DATA_USED_TO_TRACK_YOU",
  },
} satisfies Meta<typeof DataLabelHint>;
export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Hover the ✦ glyph (or Tab to it + press Enter) to play the sign-up
 * form → spam-inbox tracking vignette. Drag the Storybook a11y panel
 * open to confirm zero violations.
 */
export const ContactInfoTracking: Story = {
  render: (args) => (
    <div style={{ padding: 60 }}>
      <span style={{ marginRight: 6 }}>📇</span>
      Contact Info
      <DataLabelHint {...args} />
    </div>
  ),
};

/**
 * Same category, calmer tier — the linked story (your details run your
 * account, kept in-app). The profile editor swaps severity like this as
 * the user changes their per-row tier selection.
 */
export const ContactInfoLinked: Story = {
  args: { identifier: "CONTACT_INFO", severity: "DATA_LINKED_TO_YOU" },
  render: (args) => (
    <div style={{ padding: 60 }}>
      <span style={{ marginRight: 6 }}>📇</span>
      Contact Info (linked tier)
      <DataLabelHint {...args} />
    </div>
  ),
};

/**
 * Unknown identifiers have no registered vignette — the component
 * returns null. Verified visually: no trigger should appear after the
 * label below.
 */
export const UnregisteredCombination: Story = {
  args: { identifier: "NOT_A_REAL_CATEGORY", severity: "DATA_LINKED_TO_YOU" },
  render: (args) => (
    <div style={{ padding: 60 }}>
      <span style={{ marginRight: 6 }}>🛰️</span>
      Unknown category (no vignette)
      <DataLabelHint {...args} />
    </div>
  ),
};

/**
 * Flipping to guardian focus turns `flag.global.label_hints` off, so
 * the trigger disappears entirely even though the pair is registered.
 */
export const HiddenForGuardian: Story = {
  parameters: { focus: FOCUS_GUARDIAN_DECLUTTER },
  render: (args) => (
    <div style={{ padding: 60 }}>
      <span style={{ marginRight: 6 }}>📇</span>
      Contact Info (label hint hidden for guardian)
      <DataLabelHint {...args} />
    </div>
  ),
};
