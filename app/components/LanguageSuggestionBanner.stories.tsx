import type { Meta, StoryObj } from "@storybook/nextjs";
import LanguageSuggestionBanner from "./LanguageSuggestionBanner";

const meta: Meta<typeof LanguageSuggestionBanner> = {
  title: "I/LanguageSuggestionBanner",
  component: LanguageSuggestionBanner,
  parameters: { layout: "padded" },
  args: {
    target: "zh",
    onDismiss: () => {
      // eslint-disable-next-line no-console
      console.log("LanguageSuggestionBanner.onDismiss");
    },
  },
};
export default meta;

type Story = StoryObj<typeof LanguageSuggestionBanner>;

export const SuggestChinese: Story = {};

export const SuggestEnglish: Story = {
  args: { target: "en" },
  globals: { locale: "zh" },
};
