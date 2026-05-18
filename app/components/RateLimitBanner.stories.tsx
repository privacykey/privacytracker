import type { Meta, StoryObj } from "@storybook/nextjs";
import RateLimitBanner from "./RateLimitBanner";

const meta: Meta<typeof RateLimitBanner> = {
  title: "I/RateLimitBanner",
  component: RateLimitBanner,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Polls `/api/rate-limit/status?category=…` for an active cooldown. " +
          "Without a backend the banner renders nothing (no active cooldown). " +
          "Stories document the variants the parent surfaces can pass.",
      },
    },
  },
  args: {
    category: "search",
    variant: "inline",
  },
};
export default meta;

type Story = StoryObj<typeof RateLimitBanner>;

export const SearchInline: Story = {};

export const ScrapeInline: Story = {
  args: { category: "scrape" },
};

export const Floating: Story = {
  args: { variant: "floating" },
};
