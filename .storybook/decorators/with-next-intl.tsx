import type { Decorator } from "@storybook/nextjs";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../messages/en";
import zhMessages from "../messages/zh";

const MESSAGES: Record<string, typeof enMessages> = {
  en: enMessages,
  zh: zhMessages,
};

const STATIC_NOW = new Date("2026-05-14T00:00:00.000Z");

export const withNextIntl: Decorator = (Story, context) => {
  const locale = (context.globals.locale as string) || "en";
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
