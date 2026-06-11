import type { Meta, StoryObj } from "@storybook/nextjs";
import { useState } from "react";
import Toast from "./Toast";

const meta = {
  title: "I/Toast",
  component: Toast,
  parameters: { layout: "centered" },
  argTypes: {
    role: { control: "text" },
  },
} satisfies Meta<typeof Toast>;
export default meta;

type Story = StoryObj<typeof meta>;

/** Renders nothing until non-empty children arrive — this is the steady state. */
export const Visible: Story = {
  args: { children: "Saved" },
};

export const LongMessage: Story = {
  args: { children: "Layout reset to the default arrangement" },
};

/**
 * The wrapper owns the entrance/exit choreography: it holds the last
 * non-empty content for the exit animation instead of unmounting the
 * instant the parent clears it. Toggle to watch the symmetric in/out.
 */
export const Interactive: Story = {
  render: () => {
    const [msg, setMsg] = useState<string | null>(null);
    return (
      <div style={{ display: "grid", gap: 16, justifyItems: "center" }}>
        <button
          className="btn btn-primary"
          onClick={() => {
            setMsg("Copied to clipboard");
            window.setTimeout(() => setMsg(null), 1500);
          }}
          type="button"
        >
          Trigger toast
        </button>
        <Toast>{msg}</Toast>
      </div>
    );
  },
};
