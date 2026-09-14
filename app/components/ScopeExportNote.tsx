"use client";

import { useTranslations } from "next-intl";
import { useScopeLabel } from "./DeviceScopeProvider";
import "./ScopeExportNote.css";

/**
 * Tells the user that an export covers every device, even though the
 * page around it is showing one.
 *
 * Exports are deliberately NOT scoped — an export is a record of the
 * install, and whoever opens the file has no way to tell a partial one
 * from a complete one. But "deliberately unscoped" was only ever written
 * in a code comment, which meant the Stats page could read "3 Apps
 * Tracked" directly above an Export button that ships ten, with nothing
 * on screen reconciling the two. A silent mismatch between what a page
 * shows and what its download contains is the kind of surprise that
 * makes people distrust the whole tool.
 *
 * Renders nothing when no scope is active, which is the common case —
 * this is a reconciliation, not a permanent disclaimer.
 */
export default function ScopeExportNote({
  /** Overrides the default sentence for exports that aren't app lists
   *  (the audit bundle, say, which is about recommendations). */
  messageKey = "export_note",
}: {
  messageKey?: "export_note" | "export_note_bundle";
}) {
  const t = useTranslations("device_scope");
  const scopeLabel = useScopeLabel();

  if (!scopeLabel) {
    return null;
  }

  return (
    <p className="scope-export-note">
      <span aria-hidden="true" className="scope-export-note-icon">
        ⓘ
      </span>
      {t(messageKey, { scope: scopeLabel })}
    </p>
  );
}
