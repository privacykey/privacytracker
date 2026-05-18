import type { Meta, StoryObj } from "@storybook/nextjs";
import ImportedAppsTable, {
  type ImportedAppEntryView,
} from "./ImportedAppsTable";

const SAMPLE_ENTRIES: ImportedAppEntryView[] = [
  {
    id: "instagram",
    name: "Instagram",
    bundleId: "com.burbn.instagram",
    developer: "Instagram, Inc.",
    source: "cfgutil",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    bundleId: "net.whatsapp.WhatsApp",
    developer: "WhatsApp Inc.",
    source: "cfgutil",
  },
  {
    id: "duolingo",
    name: "Duolingo",
    bundleId: "com.duolingo.DuolingoMobile",
    developer: "Duolingo",
    source: "file",
  },
  {
    id: "manual-app",
    name: "Custom App",
    source: "manual",
  },
  {
    id: "webclip",
    name: "My WebClip",
    source: "ocr",
    likelyWebClip: true,
  },
];

const meta = {
  title: "I/ImportedAppsTable",
  component: ImportedAppsTable,
  parameters: { layout: "padded" },
  args: {
    entries: SAMPLE_ENTRIES,
    onAdd: (raw: string) => {
      // eslint-disable-next-line no-console
      console.log("ImportedAppsTable.onAdd", raw);
    },
    onRemove: (id: string) => {
      // eslint-disable-next-line no-console
      console.log("ImportedAppsTable.onRemove", id);
    },
  },
} satisfies Meta<typeof ImportedAppsTable>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { entries: [] },
};

export const SingleEntry: Story = {
  args: { entries: [SAMPLE_ENTRIES[0]] },
};

export const ChineseLocale: Story = {
  globals: { locale: "zh" },
};
