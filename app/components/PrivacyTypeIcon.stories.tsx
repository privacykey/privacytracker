import type { Meta, StoryObj } from "@storybook/nextjs";
import PrivacyTypeIcon from "./PrivacyTypeIcon";

const meta = {
  title: "I/PrivacyTypeIcon",
  component: PrivacyTypeIcon,
  // The icon sizes off the inherited font-size (1.15em); bump it so the
  // canvas isn't a fleck. Colour follows `currentColor`.
  decorators: [
    (Story) => (
      <div style={{ fontSize: 48, color: "var(--fg)" }}>
        <Story />
      </div>
    ),
  ],
  argTypes: {
    identifier: {
      control: "inline-radio",
      options: [
        "not_collected",
        "not_linked",
        "linked",
        "tracking",
        "DATA_NOT_COLLECTED",
        "DATA_NOT_LINKED_TO_YOU",
        "DATA_LINKED_TO_YOU",
        "DATA_USED_TO_TRACK_YOU",
      ],
    },
    tier: { control: "text" },
  },
} satisfies Meta<typeof PrivacyTypeIcon>;
export default meta;

type Story = StoryObj<typeof meta>;

export const NotCollected: Story = { args: { identifier: "not_collected" } };
export const NotLinked: Story = { args: { identifier: "not_linked" } };
export const Linked: Story = { args: { identifier: "linked" } };
export const Tracking: Story = { args: { identifier: "tracking" } };

/** Unknown / null identifiers fall back to the "not collected" glyph. */
export const UnknownFallback: Story = { args: { identifier: "???" } };

/** All four severity tiers side by side, mirroring how they read in a row. */
export const AllTiers: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        gap: 24,
        alignItems: "center",
        fontSize: 40,
        color: "var(--fg)",
      }}
    >
      <PrivacyTypeIcon identifier="not_collected" />
      <PrivacyTypeIcon identifier="not_linked" />
      <PrivacyTypeIcon identifier="linked" />
      <PrivacyTypeIcon identifier="tracking" />
    </div>
  ),
};

/**
 * Apple's verbose identifiers map to the same four glyphs as the short
 * tier keys — proof the live scraper and the historical shoebox parser
 * render identically downstream.
 */
export const AppleIdentifiers: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        gap: 24,
        alignItems: "center",
        fontSize: 40,
        color: "var(--fg)",
      }}
    >
      <PrivacyTypeIcon identifier="DATA_NOT_COLLECTED" />
      <PrivacyTypeIcon identifier="DATA_NOT_LINKED_TO_YOU" />
      <PrivacyTypeIcon identifier="DATA_LINKED_TO_YOU" />
      <PrivacyTypeIcon identifier="DATA_USED_TO_TRACK_YOU" />
    </div>
  ),
};
