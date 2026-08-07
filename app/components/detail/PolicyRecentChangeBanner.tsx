"use client";

import { useTranslations } from "next-intl";
import type { RecentPolicyChangeHint } from "./types";

export default function PolicyRecentChangeBanner({
  recentPolicyChange,
  policyDiffAlertDays,
  onViewDiff,
  formatDate,
}: {
  recentPolicyChange: RecentPolicyChangeHint | null;
  policyDiffAlertDays: number;
  onViewDiff: () => void;
  formatDate: (ts: number) => string;
}) {
  const tDetail = useTranslations("app_detail");
  if (!recentPolicyChange || policyDiffAlertDays <= 0) {
    return null;
  }

  // Days since the new text first landed. Clamp at 0 so clock-skew
  // (changedAt slightly in the future) doesn't render a negative number.
  const ageMs = Math.max(0, Date.now() - recentPolicyChange.changedAt);
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  const ageCopy =
    ageDays === 0
      ? tDetail("policy_diff_alert.age_today")
      : ageDays === 1
        ? tDetail("policy_diff_alert.age_yesterday")
        : tDetail("policy_diff_alert.age_days_ago", { count: ageDays });

  return (
    <div className="policy-diff-alert" role="status">
      <span aria-hidden="true" className="policy-diff-alert-icon">
        📝
      </span>
      <div className="policy-diff-alert-body">
        <strong>{tDetail("policy_diff_alert.lead", { age: ageCopy })}</strong>
        {tDetail("policy_diff_alert.body", {
          date: formatDate(recentPolicyChange.changedAt),
          days: policyDiffAlertDays,
        })}{" "}
        <button
          className="policy-diff-alert-link"
          onClick={onViewDiff}
          type="button"
        >
          {tDetail("policy_diff_alert.view_diff")}
        </button>
      </div>
    </div>
  );
}
