/**
 * Clean-slate HEALTH capture motif — "App A · Health" logging live
 * vitals. A heart-rate readout pops in, a one-beat ECG trace draws, and
 * three daily metrics cascade beneath. Bespoke to the clean-slate set
 * (does not reuse the shared watch motif). Animations: `.v-csm` set in
 * clean-slate.css.
 */
export default function MotifHealthApp() {
  return (
    <g className="v-csm">
      <rect
        fill="var(--surface)"
        height="146"
        rx="8"
        stroke="var(--border-strong)"
        width="126"
        x="10"
        y="22"
      />

      {/* Header */}
      <rect
        fill="var(--pink, #ec4899)"
        height="15"
        rx="3"
        width="15"
        x="16"
        y="29"
      />
      <text fill="#ffffff" fontSize="9" textAnchor="middle" x="23.5" y="40">
        ❤
      </text>
      <text fill="var(--text-2)" fontSize="8" fontWeight="700" x="35" y="40">
        App A · Health
      </text>

      {/* Live heart-rate readout + one-beat trace */}
      <g className="v-csm-pop">
        <text
          fill="var(--pink, #ec4899)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="20"
          fontWeight="800"
          x="16"
          y="86"
        >
          72
        </text>
        <text fill="var(--text-3)" fontSize="7" x="48" y="86">
          BPM
        </text>
        <polyline
          fill="none"
          points="74,84 84,84 89,74 96,96 101,80 107,84 122,84"
          stroke="var(--pink, #ec4899)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.6"
        />
      </g>

      {/* Daily metrics */}
      <text
        fill="var(--text-3)"
        fontSize="6"
        fontWeight="700"
        letterSpacing="0.4"
        x="16"
        y="104"
      >
        TODAY
      </text>

      <g className="v-csm-row-1">
        <text fill="var(--text)" fontSize="7.5" x="16" y="120">
          Resting HR
        </text>
        <text
          fill="var(--text-2)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7.5"
          textAnchor="end"
          x="130"
          y="120"
        >
          58 bpm
        </text>
      </g>
      <g className="v-csm-row-2">
        <text fill="var(--text)" fontSize="7.5" x="16" y="138">
          Steps / day
        </text>
        {/* The flagged metric — deliberately low, in red, so it reads as
            the lever the premium output picks up on. */}
        <text
          fill="var(--red, #dc2626)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7.5"
          fontWeight="700"
          textAnchor="end"
          x="130"
          y="138"
        >
          1,240 ▾
        </text>
      </g>
      <g className="v-csm-row-3">
        <text fill="var(--text)" fontSize="7.5" x="16" y="156">
          Sleep
        </text>
        <text
          fill="var(--text-2)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7.5"
          textAnchor="end"
          x="130"
          y="156"
        >
          6h 12m
        </text>
      </g>
    </g>
  );
}
