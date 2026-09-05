import type { Metadata } from "next";
import LegalContent from "@/app/components/content/LegalContent";

export const metadata: Metadata = {
  title: "Legal — Open-source libraries & licences",
  description:
    "Third-party libraries bundled with privacytracker, their versions, licences, and what each one is used for. Grouped by licence identifier with a sticky sidebar.",
};

/**
 * Rust-core Phase 0 (layout batch): the translated body moved into the
 * client component LegalContent so this route prerenders statically and the
 * copy follows the client-resolved locale; the metadata title is
 * build-time English that RouteTitle localises on the client.
 */
export default function LegalPage() {
  return <LegalContent />;
}
