import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("onboard_goals_title"),
  };
}

export default function OnboardGoalsPage() {
  redirect("/welcome?customize=1");
}
