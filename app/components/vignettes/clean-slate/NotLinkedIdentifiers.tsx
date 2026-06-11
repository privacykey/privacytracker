/**
 * IDENTIFIERS · not-linked tier — the persistent ID never leaves; a
 * throwaway token is sent instead. Your session is one anonymous blip
 * among millions and resets, so nothing can be stitched across time.
 */
export default function NotLinkedIdentifiers() {
  const tokens = Array.from({ length: 48 }, (_, i) => ({
    cx: 178 + (i % 12) * 11,
    cy: 92 + Math.floor(i / 12) * 11,
  }));

  return (
    <g className="v-cs v-cs-nl-identifiers">
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
        WHAT'S SENT
      </text>

      <rect
        fill="var(--bg-2, #fff)"
        height="108"
        rx="9"
        stroke="var(--border-strong)"
        width="140"
        x="8"
        y="40"
      />
      <text fill="var(--text-2)" fontSize="7.5" fontWeight="700" x="18" y="56">
        Persistent ID
      </text>
      <line stroke="var(--border)" x1="18" x2="138" y1="61" y2="61" />
      <g className="v-cs-redact">
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7.5"
          fontWeight="700"
          x="18"
          y="82"
        >
          A1B2-C3D4
        </text>
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7.5"
          fontWeight="700"
          x="18"
          y="98"
        >
          -E5F6
        </text>
      </g>
      <line
        className="v-cs-strike"
        stroke="var(--red, #dc2626)"
        strokeWidth="1.6"
        x1="16"
        x2="86"
        y1="80"
        y2="92"
      />
      <text fill="var(--text-3)" fontSize="6" x="18" y="116">
        never leaves the phone
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
          One blip among millions
        </text>
        <line stroke="var(--border)" x1="175" x2="303" y1="61" y2="61" />
        <text
          fill="var(--green, #16a34a)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="9"
          fontWeight="800"
          x="175"
          y="78"
        >
          t_9x4k2
        </text>
        <text fill="var(--text-3)" fontSize="6" x="226" y="78">
          resets each session
        </text>
        {tokens.map((d, i) => (
          <circle
            cx={d.cx}
            cy={d.cy}
            fill="#64748b"
            fillOpacity={i === 17 ? "0.95" : "0.4"}
            key={`${d.cx}-${d.cy}`}
            r="1.8"
          />
        ))}
        <text
          fill="var(--text)"
          fontSize="7.5"
          fontWeight="700"
          x="175"
          y="143"
        >
          1 of 1.1M sessions · never linked
        </text>
      </g>
    </g>
  );
}
