import type { Meta, StoryObj } from "@storybook/nextjs";
import type { Annotation } from "../../lib/annotations";
import AnnotationsSidebar from "./AnnotationsSidebar";

const NOW = Date.now();

const SAMPLE_ANNOTATIONS: Annotation[] = [
  {
    id: "ann-1",
    appId: "instagram",
    content:
      "**Recommender note:** They have a public-facing privacy policy that lists every third party. Cross-references with App Store labels.",
    tag: "positive",
    source: "imported",
    sourceName: "Alex",
    visibility: "export",
    createdAt: NOW - 1000 * 60 * 60 * 6,
    updatedAt: NOW - 1000 * 60 * 60 * 6,
    deletedAt: null,
  },
  {
    id: "ann-2",
    appId: "instagram",
    content:
      "Verified the third-party SDK list against their privacy nutrition label.",
    tag: "follow_up",
    source: "user",
    sourceName: null,
    visibility: "private",
    createdAt: NOW - 1000 * 60 * 60 * 24,
    updatedAt: NOW - 1000 * 60 * 60 * 24,
    deletedAt: null,
  },
  {
    id: "ann-3",
    appId: "instagram",
    content: "Concerned about how aggressively they use Identifiers for ads.",
    tag: "concern",
    source: "user",
    sourceName: null,
    visibility: "private",
    createdAt: NOW - 1000 * 60 * 60 * 24 * 3,
    updatedAt: NOW - 1000 * 60 * 60 * 24 * 3,
    deletedAt: null,
  },
];

const meta: Meta<typeof AnnotationsSidebar> = {
  title: "I/AnnotationsSidebar",
  component: AnnotationsSidebar,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof AnnotationsSidebar>;

export const ExpandedWithNotes: Story = {
  args: {
    appId: "instagram",
    initialAnnotations: SAMPLE_ANNOTATIONS,
    initiallyExpanded: true,
  },
};

export const Collapsed: Story = {
  args: {
    appId: "instagram",
    initialAnnotations: SAMPLE_ANNOTATIONS,
    initiallyExpanded: false,
  },
};

export const EmptyState: Story = {
  args: {
    appId: "instagram",
    initialAnnotations: [],
    initiallyExpanded: true,
  },
};
