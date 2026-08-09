"use client";

import { useTranslations } from "next-intl";
import type { PolicyChunkNote } from "../../../lib/policy-summary-meta";

/**
 * Collapsed inspector for the per-chunk summaries produced during the
 * chunked-summarise path. Only rendered when the stored notes match the
 * current policy's content hash (see hydratePolicyAnalysis). Lets the user
 * validate what each chunk produced before trusting the merged rollup —
 * directly addresses the "can't validate if responses are valid" concern.
 */
export default function PolicyChunkNotesBlock({
  notes,
}: {
  notes: PolicyChunkNote[];
}) {
  const tDetail = useTranslations("app_detail");
  return (
    <details
      className="policy-chunk-notes"
      style={{
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: 8,
        background: "var(--surface-2)",
        border: "1px solid var(--border-1)",
        fontSize: 12,
      }}
    >
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        {tDetail("policy_chunk_notes.summary", { count: notes.length })}
        <span
          style={{
            color: "var(--text-3, #6c7c94)",
            fontWeight: 400,
            marginLeft: 8,
          }}
        >
          {tDetail("policy_chunk_notes.summary_hint")}
        </span>
      </summary>
      <div
        style={{
          marginTop: 10,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {notes.map((note, index) => (
          <div
            key={index}
            style={{
              padding: 10,
              borderRadius: 6,
              background: "var(--surface-3)",
              border: "1px solid var(--border-2)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              {tDetail("policy_chunk_notes.chunk_heading", {
                index: index + 1,
                total: notes.length,
              })}
            </div>
            <p
              style={{
                margin: "0 0 8px 0",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {note.summary || (
                <em style={{ color: "var(--text-3, #6c7c94)" }}>
                  {tDetail("policy_no_summary")}
                </em>
              )}
            </p>
            {note.highlights.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {note.highlights.map((highlight, hIndex) => (
                  <li key={hIndex} style={{ marginBottom: 2 }}>
                    {highlight}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
