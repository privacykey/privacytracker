import type { Metadata } from "next";
import HelpFocusContent from "@/app/components/content/HelpFocusContent";

export const metadata: Metadata = {
  title: "Your Focus — privacytracker",
  description:
    "How the choices you make on the welcome screen — what you want to do, who it's for, and which features you want — tailor the dashboard, what each option means, and how to change it.",
};

/**
 * Rust-core Phase 0 (layout batch): the translated body moved into the
 * client component HelpFocusContent so this route prerenders statically and the
 * copy follows the client-resolved locale; the metadata title is
 * build-time English that RouteTitle localises on the client.
 */
export default function HelpFocusPage() {
  return <HelpFocusContent />;
}
