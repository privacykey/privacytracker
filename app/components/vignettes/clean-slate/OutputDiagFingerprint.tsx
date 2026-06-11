import CleanSlatePulses from "./CleanSlatePulses";

/**
 * DIAGNOSTICS · track tier — the "boring" device facts in a crash report
 * (model, OS build, battery) combine into a fingerprint that picks you
 * out of a crowd, no name needed. The three facts converge into one
 * fingerprint id, and a single dot in the crowd lights up: you.
 */
export default function OutputDiagFingerprint() {
  const chips = [
    { label: "iPhone 15", x: 158, w: 46 },
    { label: "iOS 18.2", x: 210, w: 42 },
    { label: "🔋 12%", x: 258, w: 44 },
  ];

  // 8×3 crowd grid; one of them is you.
  const crowd: { cx: number; cy: number }[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      crowd.push({ cx: 172 + c * 13.5, cy: 96 + r * 14 });
    }
  }
  const you = { cx: 226, cy: 110 };

  return (
    <g className="v-cs v-cs-diag-track">
      <CleanSlatePulses y={84} />

      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="6.5"
        fontWeight="700"
        letterSpacing="0.5"
        textAnchor="middle"
        x="232"
        y="12"
      >
        ENOUGH TO PICK YOU OUT
      </text>

      {/* The three boring facts */}
      {chips.map((c, i) => (
        <g className={`v-cs-row v-cs-row-${i + 1}`} key={c.label}>
          <rect
            fill="var(--surface-active)"
            height="13"
            rx="6.5"
            stroke="var(--border-strong)"
            width={c.w}
            x={c.x}
            y="20"
          />
          <text
            fill="var(--text-2)"
            fontFamily="ui-monospace, 'SF Mono', monospace"
            fontSize="6"
            textAnchor="middle"
            x={c.x + c.w / 2}
            y="29"
          >
            {c.label}
          </text>
        </g>
      ))}

      {/* …converge into one fingerprint */}
      <path
        className="v-cs-link"
        d="M 181 33 L 225 56"
        fill="none"
        stroke="var(--red, #dc2626)"
        strokeWidth="1"
      />
      <path
        className="v-cs-link"
        d="M 231 33 L 232 56"
        fill="none"
        stroke="var(--red, #dc2626)"
        strokeWidth="1"
      />
      <path
        className="v-cs-link"
        d="M 280 33 L 239 56"
        fill="none"
        stroke="var(--red, #dc2626)"
        strokeWidth="1"
      />
      <g className="v-cs-fade">
        <rect
          fill="rgba(220,38,38,0.12)"
          height="15"
          rx="7.5"
          stroke="var(--red, #dc2626)"
          width="68"
          x="198"
          y="56"
        />
        <text
          fill="var(--red, #dc2626)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7"
          fontWeight="700"
          textAnchor="middle"
          x="232"
          y="66.5"
        >
          fp_8c2e07
        </text>
      </g>

      {/* The crowd — and the one dot that matches */}
      <g className="v-cs-fade">
        {crowd.map((d) =>
          d.cx === you.cx && d.cy === you.cy ? null : (
            <circle
              cx={d.cx}
              cy={d.cy}
              fill="var(--text-3)"
              fillOpacity="0.45"
              key={`${d.cx}-${d.cy}`}
              r="3.5"
            />
          )
        )}
      </g>
      <g className="v-cs-stamp">
        <circle
          cx={you.cx}
          cy={you.cy}
          fill="var(--blue-soft, #dbeafe)"
          r="7"
          stroke="var(--blue, #2563eb)"
          strokeWidth="1.2"
        />
        <text fontSize="8" textAnchor="middle" x={you.cx} y={you.cy + 3}>
          🧑
        </text>
        <text
          fill="var(--blue, #2563eb)"
          fontSize="5.5"
          fontWeight="700"
          textAnchor="middle"
          x={you.cx}
          y="140"
        >
          matched to you
        </text>
      </g>

      <text
        className="v-cs-fade"
        fill="var(--red, #dc2626)"
        fontSize="6"
        fontWeight="700"
        textAnchor="middle"
        x="232"
        y="156"
      >
        only one phone fits — yours
      </text>
    </g>
  );
}
