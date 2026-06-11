"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { PurposeFocusInput } from "@/lib/onboarding-purpose";
import { seedSampleApps } from "@/lib/sample-apps";
import type { UserTaskId } from "@/lib/tasks";
import { useFlag } from "../../lib/feature-flags-hooks";
import FocusPurposeForm from "./FocusPurposeForm";

interface Props {
  initialFocus: PurposeFocusInput | null;
}

const DEFAULT_FOCUS: PurposeFocusInput = {
  audience: "self",
  understand: true,
  declutter: false,
  minimal: false,
  accessibility: false,
  workflow: "self_monitor",
};

export default function WelcomeSplash({ initialFocus }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations("onboarding.welcome");
  const tCommon = useTranslations("common");
  const sampleDataButtonOn =
    useFlag("flag.onboarding.sample_data_button") === "on";
  const audiencePickerSkipOn =
    useFlag("flag.onboarding.audience_picker.skip") === "on";

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function optInTasks(taskIds: UserTaskId[]) {
    for (const id of taskIds) {
      try {
        await fetch("/api/user-tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, action: "opt_in" }),
        });
      } catch (taskError) {
        console.warn("[welcome] task opt-in failed:", taskError);
      }
    }
  }

  async function commitAndContinue(
    focus: PurposeFocusInput & { taskOptIns?: UserTaskId[] }
  ) {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audience: focus.audience,
          understand: focus.understand,
          declutter: focus.declutter,
          minimal: focus.minimal,
          accessibility: focus.accessibility,
          workflow: focus.workflow,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? t("save_failed"));
      }
      await optInTasks(focus.taskOptIns ?? []);
      router.push("/onboard/profile");
    } catch (err) {
      console.error("[welcome] save failed:", err);
      setError(err instanceof Error ? err.message : t("save_failed"));
      setSaving(false);
    }
  }

  function handleSkip() {
    void commitAndContinue({ ...DEFAULT_FOCUS, taskOptIns: [] });
  }

  function handleSampleData() {
    seedSampleApps();
    void fetch("/api/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(DEFAULT_FOCUS),
    }).finally(() => {
      router.push("/dashboard?sample=1");
    });
  }

  const footer = (
    <>
      {sampleDataButtonOn && (
        <div className="welcome-tertiary">
          <button
            className="welcome-link welcome-sample-data"
            disabled={saving}
            onClick={handleSampleData}
            type="button"
          >
            {t("sample_data_button")} →
          </button>
        </div>
      )}

      <p className="welcome-footnote">
        {t("footnote_prompt")}{" "}
        <Link className="welcome-link" href="/help/focus">
          {t("help_link")}
        </Link>
      </p>
    </>
  );

  return (
    <FocusPurposeForm
      advancedInitiallyOpen={searchParams?.get("customize") === "1"}
      error={error}
      extraActions={
        audiencePickerSkipOn ? (
          <button
            className="btn btn-ghost welcome-skip"
            disabled={saving}
            onClick={handleSkip}
            type="button"
          >
            {t("skip")}
          </button>
        ) : null
      }
      eyebrow={t("eyebrow")}
      footer={footer}
      initial={initialFocus ?? DEFAULT_FOCUS}
      mode="onboarding"
      onSubmit={(resolved) => commitAndContinue(resolved)}
      saving={saving}
      savingLabel={tCommon("saving")}
      submitLabel={t("next")}
      subtitle={t("subhead_long")}
      title={t("headline")}
    />
  );
}
