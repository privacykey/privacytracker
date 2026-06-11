/**
 * USAGE DATA · capture motif — an iOS-style Screen Time card: total for
 * the day and an hourly bar chart that spikes late at night, with the
 * 11pm bar highlighted as the peak. Bespoke to the clean-slate set.
 */
export default function MotifScreenTime() {
  const bars = [8, 12, 7, 11, 15, 10, 16, 13, 21, 18, 28, 34];
  const baseline = 112;
  return (
    <g className="v-csm">
      <rect
        fill="var(--surface)"
        height="140"
        rx="8"
        stroke="var(--border-strong)"
        width="126"
        x="10"
        y="22"
      />
      <text fill="var(--text-2)" fontSize="8" fontWeight="700" x="18" y="39">
        Screen Time
      </text>
      <text fill="var(--text-3)" fontSize="6.5" textAnchor="end" x="130" y="39">
        2h 10m
      </text>
      <line stroke="var(--border)" x1="16" x2="130" y1="45" y2="45" />

      <g className="v-csm-pop">
        {bars.map((h, i) => (
          <rect
            fill={i === bars.length - 1 ? "#0d9488" : "var(--border-strong)"}
            height={h}
            key={`b-${i}`}
            rx="1.5"
            width="6"
            x={18 + i * 9}
            y={baseline - h}
          />
        ))}
        <line
          stroke="var(--border)"
          x1="16"
          x2="124"
          y1={baseline}
          y2={baseline}
        />
        <text
          fill="#0d9488"
          fontSize="5.5"
          fontWeight="700"
          textAnchor="end"
          x="123"
          y="122"
        >
          11pm
        </text>
      </g>

      <text fill="var(--text-2)" fontSize="6.5" fontWeight="600" x="18" y="134">
        Peak 11pm · 14 sessions
      </text>
    </g>
  );
}
