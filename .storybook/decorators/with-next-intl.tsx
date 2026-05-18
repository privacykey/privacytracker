import type { Decorator } from "@storybook/nextjs";
import { NextIntlClientProvider } from "next-intl";
import { useGlobals } from "storybook/preview-api";
import enMessages from "../messages/en";
import zhMessages from "../messages/zh";

const MESSAGES: Record<string, typeof enMessages> = {
  en: enMessages,
  zh: zhMessages,
};

const STATIC_NOW = new Date("2026-05-14T00:00:00.000Z");

export const withNextIntl: Decorator = (Story) => {
  // Subscribe to global changes via the hook — reading `context.globals.locale`
  // alone doesn't trigger a re-render when the toolbar flips in Storybook 10.
  const [globals] = useGlobals();
  const locale = (globals.locale as string) || "en";
  const messages = MESSAGES[locale] ?? MESSAGES.en;
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      now={STATIC_NOW}
      timeZone="UTC"
    >
      <Story />
    </NextIntlClientProvider>
  );
};
