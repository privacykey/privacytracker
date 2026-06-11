import CleanSlatePulses from "./CleanSlatePulses";

/**
 * PURCHASES · linked tier — the calm use: your orders are kept in your
 * account so you can reorder and pull up receipts. Tied to you, used by
 * App A, not profiled or sold.
 */
export default function OutputPurchasesOrders() {
  return (
    <g className="v-cs v-cs-purchases-linked">
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
        <text fill="var(--text-2)" fontSize="8" fontWeight="700" x="164" y="53">
          Your orders
        </text>
        <rect
          fill="none"
          height="13"
          rx="6.5"
          stroke="var(--orange, #ea580c)"
          strokeWidth="1.2"
          width="46"
          x="252"
          y="44"
        />
        <text
          fill="var(--orange, #ea580c)"
          fontSize="6.5"
          fontWeight="800"
          textAnchor="middle"
          x="275"
          y="53"
        >
          LINKED
        </text>
        <line stroke="var(--border)" x1="164" x2="300" y1="60" y2="60" />
      </g>

      <g className="v-cs-row v-cs-row-1">
        <text fill="var(--text)" fontSize="7.5" x="164" y="80">
          Puppy food
        </text>
        <rect
          fill="var(--surface)"
          height="13"
          rx="6.5"
          stroke="var(--border-strong)"
          width="40"
          x="260"
          y="71"
        />
        <text
          fill="var(--text-2)"
          fontSize="6.5"
          fontWeight="700"
          textAnchor="middle"
          x="280"
          y="80"
        >
          reorder
        </text>
      </g>
      <g className="v-cs-row v-cs-row-2">
        <text fill="var(--text-3)" fontSize="7.5" x="164" y="100">
          Receipts
        </text>
        <text
          fill="var(--text)"
          fontSize="7.5"
          textAnchor="end"
          x="300"
          y="100"
        >
          saved for you
        </text>
      </g>

      <text
        className="v-cs-fade"
        fill="var(--orange, #ea580c)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="130"
      >
        For receipts & reorder · not sold
      </text>
    </g>
  );
}
