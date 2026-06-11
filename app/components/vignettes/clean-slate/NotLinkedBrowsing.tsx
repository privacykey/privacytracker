/**
 * BROWSING · not-linked tier — user id stripped at source, then the view
 * is just one increment to an aggregate category tally. No profile, no
 * way to single out your visit.
 */
export default function NotLinkedBrowsing() {
  const tally = [
    { label: "sport", v: 60, count: "12.4k" },
    { label: "food", v: 44, count: "9.0k" },
    { label: "news", v: 34, count: "7.1k" },
    { label: "tech", v: 22, count: "4.6k" },
  ];

  return (
    <g className="v-cs v-cs-nl-browsing">
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
          y="77"
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
        y1="74"
        y2="74"
      />
      <text
        fill="#e2e8f0"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        x="18"
        y="95"
      >
        view=running-shoes
      </text>
      <text
        fill="#64748b"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        x="18"
        y="113"
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
          Pooled into category counts
        </text>
        <line stroke="var(--border)" x1="175" x2="303" y1="61" y2="61" />
        {tally.map((t, i) => (
          <g key={t.label}>
            <text fill="var(--text-3)" fontSize="6.5" x="175" y={75 + i * 15}>
              {t.label}
            </text>
            <rect
              fill={i === 0 ? "var(--blue, #2563eb)" : "var(--surface-active)"}
              height="7"
              rx="2"
              width={t.v}
              x="198"
              y={70 + i * 15}
            />
            <text
              fill="var(--text-2)"
              fontSize="6"
              x={202 + t.v}
              y={76 + i * 15}
            >
              {t.count}
            </text>
          </g>
        ))}
        <text fill="var(--text)" fontSize="7" fontWeight="600" x="175" y="142">
          your view = +1 to "sport"
        </text>
      </g>
    </g>
  );
}
