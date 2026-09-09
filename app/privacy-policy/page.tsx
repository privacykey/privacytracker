import type { Metadata } from "next";
import PrivacyPolicyContent from "@/app/components/content/PrivacyPolicyContent";

export const metadata: Metadata = {
  title: "Privacy Policy — privacytracker",
  description:
    "privacytracker runs locally and does not collect, store, or transmit any personal data. This page details every third-party endpoint the app may contact while you use it.",
};

/**
 * Rust-core Phase 0 (layout batch): the translated body moved into the
 * client component PrivacyPolicyContent so this route prerenders statically and the
 * copy follows the client-resolved locale; the metadata title is
 * build-time English that RouteTitle localises on the client.
 */
export default function PrivacyPolicyPage() {
  return <PrivacyPolicyContent />;
}
