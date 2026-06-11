/**
 * USAGE DATA · not-linked tier — the user id is stripped from each event
 * at source, leaving anonymous events that only move product analytics
 * (a funnel of counts). Your tap is +1 on a chart, with no profile.
 */
export default function OutputUsageNotLinked() {
  const funnel = [
    { label: "Open", w: 128, c: "4.2M" },
    { label: "Browse", w: 86, c: "1.1M" },
    { label: "Buy", w: 38, c: "90k" },
  ];
  return (
    <g className="v-cs v-cs-usage-nl">
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

      {/* Raw event log */}
      <rect fill="#0f172a" height="108" rx="9" width="140" x="8" y="40" />
      <text fill="#94a3b8" fontSize="7" fontWeight="700" x="18" y="56">
        event.log
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
        event=open
      </text>
      <text
        fill="#64748b"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        x="18"
        y="115"
      >
        ts=23:04
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

      {/* Anonymous product-analytics funnel */}
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
          Product analytics
        </text>
        <line stroke="var(--border)" x1="175" x2="303" y1="61" y2="61" />
        {funnel.map((f, i) => (
          <g key={f.label}>
            <rect
              fill="#0d9488"
              fillOpacity="0.55"
              height="11"
              rx="2"
              width={f.w}
              x="175"
              y={70 + i * 16}
            />
            <text fill="var(--text)" fontSize="6.5" x="179" y={78 + i * 16}>
              {f.label}
            </text>
            <text
              fill="var(--text-2)"
              fontSize="6"
              textAnchor="end"
              x="303"
              y={78 + i * 16}
            >
              {f.c}
            </text>
          </g>
        ))}
        <text fill="var(--text-3)" fontSize="6.5" x="175" y="134">
          your tap = +1 · no user
        </text>
      </g>
    </g>
  );
}
