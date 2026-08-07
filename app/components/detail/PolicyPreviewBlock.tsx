"use client";

import { useTranslations } from "next-intl";

export default function PolicyPreviewBlock({
  preview,
  totalLength,
}: {
  preview: string;
  totalLength: number;
}) {
  const tDetail = useTranslations("app_detail");
  const truncated = totalLength > preview.length;
  return (
    <div
      className="policy-source-preview"
      style={{
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: 8,
        background: "var(--surface-2, var(--surface))",
        border: "1px solid var(--border-1, var(--border))",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 6,
          fontSize: 12,
        }}
      >
        <strong>
          {tDetail("policy_preview.header", {
            count: preview.length.toLocaleString(),
          })}
        </strong>
        <span style={{ color: "var(--text-3, #6c7c94)" }}>
          {truncated
            ? tDetail("policy_preview.showing_of", {
                shown: preview.length.toLocaleString(),
                total: totalLength.toLocaleString(),
              })
            : tDetail("policy_preview.total_chars", {
                total: totalLength.toLocaleString(),
              })}
        </span>
      </div>
      <pre
        style={{
          maxHeight: 320,
          overflow: "auto",
          fontSize: 12,
          background: "var(--surface-3, #0b1220)",
          padding: 10,
          borderRadius: 6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {preview}
        {truncated && `\n\n${tDetail("policy_preview.truncated_note")}`}
      </pre>
    </div>
  );
}

/**
 * Inline disclaimer rendered above every AI-generated summary. The ratings,
 * highlights, and lens descriptions are all produced by an LLM pass over the
 * scraped policy text, so they can miss nuance, hallucinate clauses that
 * aren't in the source, or mis-rate sections — especially when the policy
 * is long, structured oddly, or fetched from a Wayback archive. The links
 * back to the source (and the Internet Archive copy when we have one) are
 * the authoritative reference and the user should always be one click away
 * from the original text.
 */
