"use client";

import { useTranslations } from "next-intl";
import { isSafeExternalHref } from "../../../lib/safe-href";

export default function AiSummaryDisclaimer({
  policyUrl,
  archiveUrl,
}: {
  policyUrl?: string | null;
  archiveUrl?: string | null;
}) {
  const tDetail = useTranslations("app_detail");
  return (
    <div
      className="policy-ai-disclaimer"
      role="note"
      style={{
        marginBottom: 12,
        padding: "10px 12px",
        borderRadius: 8,
        background: "var(--surface-2)",
        border: "1px solid var(--border-1)",
        fontSize: 12,
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 14, lineHeight: "1.2" }}>
        🤖
      </span>
      <span>
        <strong>{tDetail("policy_ai_disclaimer_lead")}</strong>
        {tDetail("policy_ai_disclaimer_body")}
        {isSafeExternalHref(policyUrl) && (
          <>
            {" — "}
            <a
              className="policy-ai-disclaimer-link"
              href={policyUrl!}
              rel="noopener noreferrer"
              target="_blank"
            >
              {tDetail("policy_ai_disclaimer_source_link")}
            </a>
          </>
        )}
        {isSafeExternalHref(archiveUrl) && (
          <>
            {" · "}
            <a
              className="policy-ai-disclaimer-link"
              href={archiveUrl!}
              rel="noopener noreferrer"
              target="_blank"
            >
              {tDetail("policy_ai_disclaimer_wayback_link")}
            </a>
          </>
        )}
        .
      </span>
    </div>
  );
}
