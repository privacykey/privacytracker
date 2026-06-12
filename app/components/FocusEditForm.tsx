"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { AgeBandKey } from "@/lib/age-rating";
import type { Audience } from "@/lib/feature-flag-rules";
import { setPreviewFocus } from "@/lib/focus-preview";
import type { FocusWorkflow } from "@/lib/focus-workflow";
import FocusPurposeForm from "./FocusPurposeForm";

interface Props {
  initialAccessibility: boolean;
  initialAudience: Audience;
  initialChildAgeBand: AgeBandKey | null;
  initialDeclutter: boolean;
  initialMinimal: boolean;
  initialUnderstand: boolean;
  initialWorkflow: FocusWorkflow;
}

export default function FocusEditForm({
  initialAudience,
  initialChildAgeBand,
  initialUnderstand,
  initialDeclutter,
  initialMinimal,
  initialAccessibility,
  initialWorkflow,
}: Props) {
  const router = useRouter();
  const t = useTranslations("focus_edit");
  const [error, setError] = useState("");

  function handleSavePreview(
    focus: Parameters<typeof setPreviewFocus>[0]
  ): void {
    try {
      setPreviewFocus(focus);
    } catch (e) {
      console.error("[FocusEditForm] failed to stage preview", e);
      setError(t("stage_failed"));
      return;
    }
    router.push("/dashboard/settings#focus");
  }

  function handleCancel() {
    router.push("/dashboard/settings#focus");
  }

  return (
    <FocusPurposeForm
      cancelLabel={t("cancel")}
      error={error}
      footer={
        <p className="welcome-footnote">
          {t("footnote_prompt")}{" "}
          <Link className="welcome-link" href="/help/focus">
            {t("help_link")}
          </Link>
        </p>
      }
      initial={{
        audience: initialAudience,
        understand: initialUnderstand,
        declutter: initialDeclutter,
        minimal: initialMinimal,
        accessibility: initialAccessibility,
        workflow: initialWorkflow,
      }}
      initialChildAgeBand={initialChildAgeBand}
      mode="settings"
      onCancel={handleCancel}
      onSubmit={handleSavePreview}
      savingLabel={t("save")}
      submitLabel={t("save")}
      subtitle={t("subtitle")}
      title={t("page_title")}
    />
  );
}
