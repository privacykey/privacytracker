/**
 * DIAGNOSTICS · not-linked tier — the device id is struck from the crash
 * report at source; what survives is a rate on a dashboard. Your crash
 * nudges "0.3%" — and that's all it does.
 */
export default function OutputDiagNotLinked() {
  const versions = [
    { label: "v2.0", w: 26, c: "0.5%" },
    { label: "v2.1", w: 16, c: "0.3%" },
  ];
  return (
    <g className="v-cs v-cs-diag-nl">
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

      {/* Raw crash report — the device id is struck before it's sent */}
      <rect fill="#0f172a" height="108" rx="9" width="140" x="8" y="40" />
      <text fill="#94a3b8" fontSize="7" fontWeight="700" x="18" y="56">
        crash.log
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
          device=A1B2C3
        </text>
      </g>
      <line
        className="v-cs-strike"
        stroke="var(--red, #dc2626)"
        strokeWidth="1.4"
        x1="16"
        x2="104"
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
        crash=login
      </text>
      <text
        fill="#64748b"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        x="18"
        y="115"
      >
        os=18.2
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

      {/* The dashboard your crash becomes */}
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
          Crash dashboard
        </text>
        <line stroke="var(--border)" x1="175" x2="303" y1="61" y2="61" />

        <text fill="var(--text)" fontSize="20" fontWeight="800" x="175" y="92">
          0.3%
        </text>
        <text fill="var(--text-3)" fontSize="6.5" x="175" y="103">
          of all sessions crash
        </text>

        {versions.map((v, i) => (
          <g key={v.label}>
            <text fill="var(--text-2)" fontSize="6" x="240" y={80 + i * 14}>
              {v.label}
            </text>
            <rect
              fill="var(--text-3)"
              fillOpacity="0.45"
              height="7"
              rx="3.5"
              width={v.w}
              x="258"
              y={74 + i * 14}
            />
            <text
              fill="var(--text-2)"
              fontSize="6"
              textAnchor="end"
              x="303"
              y={80 + i * 14}
            >
              {v.c}
            </text>
          </g>
        ))}

        <text fill="var(--text-3)" fontSize="6.5" x="175" y="134">
          your crash = +1 · no device IDs
        </text>
      </g>
    </g>
  );
}
