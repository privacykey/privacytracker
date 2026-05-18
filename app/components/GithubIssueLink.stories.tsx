import type { Meta, StoryObj } from "@storybook/nextjs";
import GithubIssueLink from "./GithubIssueLink";

const meta = {
  title: "L/GithubIssueLink",
  component: GithubIssueLink,
} satisfies Meta<typeof GithubIssueLink>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Styled: Story = {
  args: { className: "site-info-hint-link" },
  render: (args) => (
    <div
      style={{
        padding: 16,
        background: "var(--bg-2)",
        borderRadius: "var(--r-md)",
      }}
    >
      <GithubIssueLink {...args} />
    </div>
  ),
};
