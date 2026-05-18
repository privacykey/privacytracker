import type { Meta, StoryObj } from "@storybook/nextjs";
import FlagHighlightHandler from "./FlagHighlightHandler";

const meta = {
  title: "L/FlagHighlightHandler",
  component: FlagHighlightHandler,
  parameters: {
    docs: {
      description: {
        component:
          "Renders nothing without `?flag-highlight=<key>` in the URL. " +
          'In real use it scrolls to and pulses the element with `data-flag-target="<key>"` ' +
          "and fires sonar + confetti effects. This story exists for the empty-state contract.",
      },
    },
  },
} satisfies Meta<typeof FlagHighlightHandler>;
export default meta;

type Story = StoryObj<typeof meta>;

export const NoQueryParam: Story = {};

export const WithFakeTarget: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <p style={{ maxWidth: 480, color: "var(--text-2)" }}>
        The handler only activates when <code>?flag-highlight=&lt;key&gt;</code>
        is present in the URL. Below is a sample target element it would scroll
        to and pulse if that query param matched its{" "}
        <code>data-flag-target</code>.
      </p>
      <div
        data-flag-target="flag.example.demo"
        style={{
          padding: "12px 18px",
          background: "var(--bg-2)",
          border: "1px solid var(--blue-dim)",
          borderRadius: "var(--r-md)",
          maxWidth: 360,
        }}
      >
        Sample flag target (<code>flag.example.demo</code>)
      </div>
      <FlagHighlightHandler />
    </div>
  ),
};
