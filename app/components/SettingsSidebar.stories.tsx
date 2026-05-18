import type { Meta, StoryObj } from "@storybook/nextjs";
import {
  FOCUS_GUARDIAN_DECLUTTER,
  FOCUS_SELF_DECLUTTER,
  FOCUS_SELF_UNDERSTAND,
} from "../../.storybook/fixtures/focus";
import SettingsSidebar from "./SettingsSidebar";

const meta = {
  title: "F/SettingsSidebar",
  component: SettingsSidebar,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Sticky left-column nav for the Settings page. Some section anchors " +
          "are gated by focus flags (e.g. guardian hides Developer Options and " +
          "wayback import). The component looks for matching section ids in the " +
          "DOM, so previews show the labels but the IntersectionObserver " +
          "highlight is inert outside the real Settings page.",
      },
    },
    focus: FOCUS_SELF_UNDERSTAND,
  },
  decorators: [
    (Story) => (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "240px 1fr",
          gap: 24,
          minHeight: 320,
        }}
      >
        <Story />
        <div style={{ color: "var(--text-2)", fontSize: 13 }}>
          Settings content normally lives here. The sidebar's active-section
          highlight relies on `#section-id` anchors in this column at runtime.
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof SettingsSidebar>;
export default meta;

type Story = StoryObj<typeof meta>;

export const SelfUnderstand: Story = {};

export const SelfDeclutter: Story = {
  parameters: { focus: FOCUS_SELF_DECLUTTER },
};

export const GuardianDeclutter: Story = {
  parameters: { focus: FOCUS_GUARDIAN_DECLUTTER },
};

export const Chinese: Story = {
  globals: { locale: "zh" },
};
