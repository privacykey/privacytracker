"use client";

import "./focus-overview.css";
import { useTranslations } from "next-intl";

export function DashboardLayoutLock({
  disabled,
  fixed,
  onChange,
}: {
  disabled?: boolean;
  fixed: boolean;
  onChange: () => void;
}) {
  const t = useTranslations("dashboard.layout_editor");
  return (
    <label className="layout-editor-lock">
      <input
        checked={fixed}
        disabled={disabled}
        onChange={onChange}
        type="checkbox"
      />
      <span>
        <strong>{t("keep_fixed")}</strong>
        <br />
        {t("keep_fixed_hint")}
      </span>
    </label>
  );
}
