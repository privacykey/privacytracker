import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import FocusEditLoader from "@/app/components/FocusEditLoader";
import Nav from "@/app/components/Nav";

/**
 * /dashboard/settings/focus — single-screen audience + goals editor
 * for the "Adjust" link off the YourFocusCard.
 *
 * Rust-core Phase 0: the active focus used to be read synchronously
 * from the DB here and handed to the client form as props. It now
 * loads from `GET /api/focus` (which already returned every field this
 * page passed down) inside FocusEditLoader, so this page is a shell.
 * The form itself still stages a session-scoped preview rather than
 * committing.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("page_metadata");
  return {
    title: t("focus_edit_title"),
    description: t("focus_edit_description"),
  };
}

export default function FocusEditPage() {
  return (
    <>
      <Nav />
      <FocusEditLoader />
    </>
  );
}
