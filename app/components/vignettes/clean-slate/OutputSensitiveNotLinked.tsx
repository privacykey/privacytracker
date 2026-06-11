/**
 * SENSITIVE INFO · not-linked tier — the identity is stripped from the
 * signal at source, leaving a category flag with no person attached. It
 * only ever moves a regional count, never a profile. Your signal becomes
 * "1 of 64,000 in your region", with no name and no device ID.
 */
export default function OutputSensitiveNotLinked() {
  const bars = [
    { label: "Region A", w: 132, c: "64k" },
    { label: "Region B", w: 94, c: "41k" },
    { label: "Region C", w: 52, c: "22k" },
  ];
  return (
    <g className="v-cs v-cs-sensitive-nl">
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

      {/* Raw signal log — the identifier is struck before anything moves */}
      <rect fill="#0f172a" height="108" rx="9" width="140" x="8" y="40" />
      <text fill="#94a3b8" fontSize="7" fontWeight="700" x="18" y="56">
        signal.log
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
        flag=faith
      </text>
      <text
        fill="#64748b"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        x="18"
        y="115"
      >
        region=AU-NSW
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

      {/* Anonymous regional tally — counts, never people */}
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
          Counts by region
        </text>
        <line stroke="var(--border)" x1="175" x2="303" y1="61" y2="61" />
        {bars.map((b, i) => (
          <g key={b.label}>
            <rect
              fill="#9333ea"
              fillOpacity="0.55"
              height="11"
              rx="2"
              width={b.w}
              x="175"
              y={70 + i * 16}
            />
            <text fill="var(--text)" fontSize="6.5" x="179" y={78 + i * 16}>
              {b.label}
            </text>
            <text
              fill="var(--text-2)"
              fontSize="6"
              textAnchor="end"
              x="303"
              y={78 + i * 16}
            >
              {b.c}
            </text>
          </g>
        ))}
        <text fill="var(--text-3)" fontSize="6.5" x="175" y="134">
          1 of 64,000 · no names, no IDs
        </text>
      </g>
    </g>
  );
}
