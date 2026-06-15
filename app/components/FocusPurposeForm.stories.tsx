import type { Meta, StoryObj } from "@storybook/nextjs";
import FocusPurposeForm from "./FocusPurposeForm";

const meta = {
  title: "I/FocusPurposeForm",
  component: FocusPurposeForm,
  parameters: { layout: "padded" },
  args: {
    mode: "onboarding",
    title: "What brings you here?",
    subtitle: "Pick a starting point — you can change this any time.",
    submitLabel: "Continue",
    savingLabel: "Saving…",
    cancelLabel: "Back",
    initial: {
      audience: "self",
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: false,
      workflow: "self_monitor",
    },
    // Required callback — no-op in isolation (no `@storybook/test` dep in repo).
    onSubmit: () => {
      // intentionally empty
    },
  },
} satisfies Meta<typeof FocusPurposeForm>;
export default meta;

type Story = StoryObj<typeof meta>;

/** The default onboarding entry — "keep an eye on my own apps". */
export const Onboarding: Story = {};

/** Same form embedded in settings: shows the cancel affordance + eyebrow. */
export const Settings: Story = {
  args: {
    mode: "settings",
    eyebrow: "Your focus",
    title: "Edit your focus",
    subtitle: "Tune what privacytracker watches for and how it frames it.",
    submitLabel: "Save changes",
    onCancel: () => {
      // intentionally empty
    },
  },
};

/** Declutter starting point — monitor off, cleanup on. */
export const Declutter: Story = {
  args: {
    initial: {
      audience: "self",
      monitor: false,
      cleanup: true,
      minimal: false,
      accessibility: false,
      workflow: "self_cleanup",
    },
  },
};

/** Helping a loved one — the audience-aware copy and motifs shift. */
export const HelpingLovedOne: Story = {
  args: {
    initial: {
      audience: "loved_one",
      monitor: true,
      cleanup: true,
      minimal: false,
      accessibility: false,
      workflow: "other_handoff",
    },
  },
};

/** Empty baseline — no goal tiles selected (a valid hard-default surface). */
export const EmptyBaseline: Story = {
  args: {
    initial: {
      audience: "self",
      monitor: false,
      cleanup: false,
      minimal: false,
      accessibility: false,
      workflow: "custom",
    },
  },
};

/** "Keep it minimal" — the subtractive switch, mutually exclusive with tiles. */
export const Minimal: Story = {
  args: {
    initial: {
      audience: "self",
      monitor: false,
      cleanup: false,
      minimal: true,
      accessibility: false,
      workflow: "custom",
    },
  },
};

/** Mid-submit: the form is disabled and shows the saving label. */
export const Saving: Story = {
  args: { saving: true },
};

/** A server-side error surfaced back into the form. */
export const WithError: Story = {
  args: { error: "Couldn't save your focus — please try again." },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};
