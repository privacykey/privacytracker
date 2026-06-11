/**
 * SEARCH HISTORY · not-linked tier — the user id is stripped from the
 * query log at source, leaving an anonymous event that only nudges a
 * public trending-searches board. Your query is +1 on a leaderboard, no
 * profile attached.
 */
export default function OutputSearchNotLinked() {
  const rows = [
    { y: 66, q: "pasta recipes", w: 128, c: "12.4k", you: true },
    { y: 82, q: "air fryer", w: 98, c: "9.1k", you: false },
    { y: 98, q: "pizza near me", w: 74, c: "7.0k", you: false },
  ];
  return (
    <g className="v-cs v-cs-search-nl">
      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="6.5"
        fontWeight="700"
        letterSpacing="0.5"
        textAnchor="middle"
        x="239"
        y="30"
      >
        WHAT'S STORED
      </text>

      {/* Raw query log */}
      <rect fill="#0f172a" height="108" rx="9" width="140" x="8" y="40" />
      <text fill="#94a3b8" fontSize="7" fontWeight="700" x="18" y="56">
        query.log
      </text>
      <line stroke="#334155" x1="18" x2="138" y1="61" y2="61" />
      <g className="v-cs-redact">
        <text
          fill="#e2e8f0"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="6.5"
          x="18"
          y="78"
        >
          user=8f3a2c
        </text>
      </g>
      <line
        className="v-cs-strike"
        stroke="var(--red, #dc2626)"
        strokeWidth="1.4"
        x1="16"
        x2="92"
        y1="75"
        y2="75"
      />
      <text
        fill="#e2e8f0"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        x="18"
        y="97"
      >
        q=pasta recipes
      </text>
      <text
        fill="#64748b"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        x="18"
        y="115"
      >
        ts=08:15
      </text>

      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="12"
        x="150"
        y="98"
      >
        →
      </text>

      {/* Anonymous trending board */}
      <g className="v-cs-fade">
        <rect
          fill="var(--bg-2, #fff)"
          height="108"
          rx="9"
          stroke="var(--border-strong)"
          width="146"
          x="166"
          y="40"
        />
        <text fill="var(--text)" fontSize="7.5" fontWeight="700" x="175" y="56">
          Trending searches
        </text>
        <line stroke="var(--border)" x1="175" x2="303" y1="61" y2="61" />
        {rows.map((r) => (
          <g key={r.q}>
            <rect
              fill={
                r.you ? "var(--blue-soft, #dbeafe)" : "var(--surface-active)"
              }
              height="13"
              rx="3"
              width={r.w}
              x="175"
              y={r.y}
            />
            <text
              fill="var(--text)"
              fontSize="7"
              fontWeight={r.you ? 700 : 400}
              x="179"
              y={r.y + 9}
            >
              {r.q}
            </text>
            <text
              fill="var(--text-2)"
              fontSize="6.5"
              textAnchor="end"
              x="303"
              y={r.y + 9}
            >
              {r.c}
            </text>
          </g>
        ))}
        <text fill="var(--text-3)" fontSize="6.5" x="175" y="128">
          your search = +1 · no profile
        </text>
      </g>
    </g>
  );
}
