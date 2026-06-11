import CleanSlatePulses from "./CleanSlatePulses";

/**
 * FINANCIAL INFO · output — "A pricier airfare for you".
 *
 * The salary + assets captured by App A on the left don't just sit in a
 * profile — they set the price you're offered. The airfare total reveals
 * a base price, then jumps up to a profiled figure with an upward arrow
 * and a reason chip ("high salary + assets"). Same flight, a worse deal,
 * because they know you can pay.
 */
export default function OutputFinancialPrice() {
  return (
    <g className="v-cs v-cs-fin-price">
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
        THE PRICE YOU SEE
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
        <text fontSize="9" x="164" y="54">
          🛒
        </text>
        <text fill="var(--text-2)" fontSize="8" fontWeight="700" x="178" y="53">
          Checkout
        </text>
        <line stroke="var(--border)" x1="164" x2="300" y1="60" y2="60" />
        <text fontSize="9" x="164" y="78">
          ✈️
        </text>
        <text fill="var(--text)" fontSize="8" x="178" y="78">
          Flight · LAX→NYC
        </text>
      </g>

      {/* Base price — revealed, then knocked back to faded/struck. */}
      <g className="v-cs-price-old">
        <text
          fill="var(--text-3)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="11"
          x="166"
          y="106"
        >
          $240
        </text>
        <line
          stroke="var(--text-3)"
          strokeWidth="1.2"
          x1="164"
          x2="196"
          y1="102"
          y2="102"
        />
      </g>

      {/* Personalised price — the punchline. */}
      <g className="v-cs-price-new">
        <text
          fill="var(--red, #dc2626)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="19"
          fontWeight="800"
          textAnchor="end"
          x="300"
          y="110"
        >
          $312
        </text>
      </g>

      <g className="v-cs-arrow">
        <text
          fill="var(--red, #dc2626)"
          fontSize="10"
          fontWeight="800"
          x="222"
          y="106"
        >
          ▲
        </text>
        <text
          fill="var(--text-3)"
          fontSize="6.5"
          fontWeight="600"
          x="164"
          y="138"
        >
          Priced for: high salary + assets
        </text>
      </g>
    </g>
  );
}
