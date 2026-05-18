import type { Meta, StoryObj } from "@storybook/nextjs";
import type { VerdictValue } from "../../lib/verdict-types";
import BulkSelectBar from "./BulkSelectBar";

const ALL_APP_IDS = [
  "instagram",
  "facebook",
  "whatsapp",
  "spotify",
  "tiktok",
  "chatgpt",
  "duolingo",
  "apple-music",
  "amazon",
  "telegram",
];

const SAMPLE_VERDICTS: Record<string, VerdictValue> = {
  instagram: "replace",
  facebook: "uninstall",
  whatsapp: "safe",
};

const meta: Meta<typeof BulkSelectBar> = {
  title: "I/BulkSelectBar",
  component: BulkSelectBar,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Floating selection toolbar in the App Grid's review queue. " +
          "Stories pass mock visible/selected id lists so each variant " +
          "renders deterministically.",
      },
    },
  },
  args: {
    onClear: () => {
      // eslint-disable-next-line no-console
      console.log("BulkSelectBar.onClear");
    },
    onExit: () => {
      // eslint-disable-next-line no-console
      console.log("BulkSelectBar.onExit");
    },
    onSelectAll: () => {
      // eslint-disable-next-line no-console
      console.log("BulkSelectBar.onSelectAll");
    },
    visibleIds: ALL_APP_IDS,
    currentVerdicts: SAMPLE_VERDICTS,
  },
};
export default meta;

type Story = StoryObj<typeof BulkSelectBar>;

export const NoneSelected: Story = {
  args: { selectedIds: [] },
};

export const FewSelected: Story = {
  args: { selectedIds: ["instagram", "facebook", "whatsapp"] },
};

export const ManySelected: Story = {
  args: { selectedIds: ALL_APP_IDS.slice(0, 8) },
};

export const AllSelected: Story = {
  args: { selectedIds: ALL_APP_IDS },
};
