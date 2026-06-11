import CleanSlatePulses from "./CleanSlatePulses";

/**
 * FINANCIAL · linked tier — your card + history saved to your own
 * account wallet for faster checkout and receipts. Held by App A, tied
 * to you, not sold.
 */
export default function OutputFinancialLinkedWallet() {
  return (
    <g className="v-cs v-cs-linked-fin">
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
          height="114"
          rx="10"
          stroke="var(--border-strong)"
          width="152"
          x="156"
          y="36"
        />
        <text fill="var(--text)" fontSize="8" fontWeight="700" x="164" y="53">
          Your wallet
        </text>
        <text fill="var(--text-3)" fontSize="6" textAnchor="end" x="300" y="53">
          App A
        </text>
        <line stroke="var(--border)" x1="164" x2="300" y1="60" y2="60" />
      </g>

      {/* Saved card */}
      <g className="v-cs-row v-cs-row-1">
        <rect fill="#334155" height="30" rx="5" width="136" x="164" y="68" />
        <rect fill="#fbbf24" height="9" rx="1.5" width="13" x="172" y="76" />
        <text
          fill="#ffffff"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="8"
          x="192"
          y="87"
        >
          •••• 4242
        </text>
        <text fill="#cbd5e1" fontSize="6" textAnchor="end" x="294" y="87">
          1-tap checkout
        </text>
      </g>

      {/* Recent order kept for receipts */}
      <g className="v-cs-row v-cs-row-2">
        <text fill="var(--text-3)" fontSize="7" x="164" y="114">
          Recent
        </text>
        <text
          fill="var(--text)"
          fontSize="7.5"
          textAnchor="end"
          x="300"
          y="114"
        >
          Flight LAX→NYC · $240
        </text>
      </g>

      <text
        className="v-cs-fade"
        fill="var(--orange, #ea580c)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="134"
      >
        Saved to your account for checkout
      </text>
    </g>
  );
}
