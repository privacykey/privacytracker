import CleanSlatePulses from "./CleanSlatePulses";

/**
 * HEALTH & FITNESS · output — "Your premium, recalculated".
 *
 * Makes the cause→effect explicit: the insurer card names the exact low
 * step count captured on the left ("Daily steps 1,240 ▾", in red), then
 * the monthly premium jumps from $84 to $128. The reason line spells it
 * out — fewer steps reads as higher risk, so the price goes up.
 */
export default function OutputHealthPremium() {
  return (
    <g className="v-cs v-cs-health">
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
        WHAT THEY DO WITH IT
      </text>

      <g className="v-cs-surface">
        <rect
          fill="var(--bg-2, #fff)"
          height="126"
          rx="10"
          stroke="var(--border-strong)"
          width="152"
          x="156"
          y="36"
        />
        <text fontSize="9" x="164" y="54">
          🛡️
        </text>
        <text fill="var(--text-2)" fontSize="8" fontWeight="700" x="178" y="53">
          HealthCover
        </text>
        <line stroke="var(--border)" x1="164" x2="300" y1="60" y2="60" />

        {/* The flagged input — same low figure captured on the left, in
            the same red, so the eye links cause to effect. */}
        <text fill="var(--text)" fontSize="8" x="164" y="78">
          Daily steps
        </text>
        <text
          fill="var(--red, #dc2626)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="8"
          fontWeight="700"
          textAnchor="end"
          x="300"
          y="78"
        >
          1,240 ▾ low
        </text>

        <text fill="var(--text)" fontSize="8" x="164" y="100">
          Monthly premium
        </text>
      </g>

      <g className="v-cs-price-old">
        <text
          fill="var(--text-3)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="11"
          x="166"
          y="122"
        >
          $84
        </text>
        <line
          stroke="var(--text-3)"
          strokeWidth="1.2"
          x1="164"
          x2="190"
          y1="118"
          y2="118"
        />
      </g>

      <g className="v-cs-price-new">
        <text
          fill="var(--red, #dc2626)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="19"
          fontWeight="800"
          textAnchor="end"
          x="300"
          y="126"
        >
          $128
        </text>
      </g>

      <g className="v-cs-arrow">
        <text
          fill="var(--red, #dc2626)"
          fontSize="10"
          fontWeight="800"
          x="220"
          y="122"
        >
          ▲
        </text>
        <text
          fill="var(--text-3)"
          fontSize="6.5"
          fontWeight="600"
          x="164"
          y="148"
        >
          Fewer steps → higher premium
        </text>
      </g>
    </g>
  );
}
