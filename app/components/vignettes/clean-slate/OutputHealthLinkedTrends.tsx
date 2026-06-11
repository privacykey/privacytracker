import CleanSlatePulses from "./CleanSlatePulses";

/**
 * HEALTH · linked tier — your vitals power your own weekly trends inside
 * the app (a private dashboard), not an insurer's risk model.
 */
export default function OutputHealthLinkedTrends() {
  const bars = [10, 16, 12, 20, 14, 24, 22];
  return (
    <g className="v-cs v-cs-linked-health">
      <CleanSlatePulses y={92} />

      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="6.5"
        fontWeight="700"
        letterSpacing="0.6"
        x="160"
        y="30"
      >
        WHAT THE APP DOES
      </text>

      <g className="v-cs-surface">
        <rect
          fill="var(--bg-2, #fff)"
          height="112"
          rx="10"
          stroke="var(--border-strong)"
          width="152"
          x="156"
          y="36"
        />
        <text fill="var(--text)" fontSize="8" fontWeight="700" x="164" y="53">
          Your week
        </text>
        <text fill="var(--text-3)" fontSize="6" textAnchor="end" x="300" y="53">
          App A · Health
        </text>
        <line stroke="var(--border)" x1="164" x2="300" y1="60" y2="60" />
      </g>

      {/* Personal activity trend */}
      <g className="v-cs-row v-cs-row-1">
        {bars.map((h, i) => (
          <rect
            fill="var(--pink, #ec4899)"
            height={h}
            key={`bar-${i}`}
            rx="2"
            width="13"
            x={168 + i * 19}
            y={104 - h}
          />
        ))}
        <line stroke="var(--border)" x1="164" x2="300" y1="105" y2="105" />
      </g>

      <g className="v-cs-row v-cs-row-2">
        <text
          fill="var(--text)"
          fontSize="7.5"
          fontWeight="600"
          x="164"
          y="120"
        >
          ▲ Activity trending up — best week yet
        </text>
      </g>

      <text
        className="v-cs-fade"
        fill="var(--orange, #ea580c)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="136"
      >
        Your private trends · App A only
      </text>
    </g>
  );
}
