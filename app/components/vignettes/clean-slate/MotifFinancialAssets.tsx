/**
 * Clean-slate financial capture motif — "App A" collecting a financial
 * profile. The salary types into a field, then a short list of assets
 * cascades in beneath it. This is the LEFT (capture) half of the
 * financial vignette; the right half quotes a higher airfare off the
 * back of it.
 *
 * Clean-slate-specific (registered in the vignette registry) so the
 * production credit-card motif is left untouched. Animations live in
 * clean-slate.css under `.v-csm-fin`.
 */
export default function MotifFinancialAssets() {
  return (
    <g className="v-csm">
      {/* App A form card */}
      <rect
        fill="var(--surface)"
        height="140"
        rx="8"
        stroke="var(--border-strong)"
        width="126"
        x="10"
        y="22"
      />

      {/* Header: $ badge + App A */}
      <rect
        fill="var(--green, #16a34a)"
        height="15"
        rx="3"
        width="15"
        x="16"
        y="29"
      />
      <text
        fill="#ffffff"
        fontSize="10"
        fontWeight="800"
        textAnchor="middle"
        x="23.5"
        y="40"
      >
        $
      </text>
      <text fill="var(--text-2)" fontSize="8" fontWeight="700" x="35" y="40">
        App A
      </text>

      {/* Salary field */}
      <text
        fill="var(--text-3)"
        fontSize="6"
        fontWeight="700"
        letterSpacing="0.4"
        x="16"
        y="57"
      >
        ANNUAL SALARY
      </text>
      <rect
        fill="var(--bg-2, #fff)"
        height="16"
        rx="3"
        stroke="var(--border-strong)"
        width="110"
        x="16"
        y="61"
      />
      <g className="v-csm-salary">
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="9"
          fontWeight="700"
          x="21"
          y="73"
        >
          $145,000
        </text>
      </g>

      {/* Assets list */}
      <text
        fill="var(--text-3)"
        fontSize="6"
        fontWeight="700"
        letterSpacing="0.4"
        x="16"
        y="92"
      >
        ASSETS
      </text>

      <g className="v-csm-row-1">
        <text fontSize="9" x="17" y="108">
          🏠
        </text>
        <text fill="var(--text)" fontSize="7.5" x="33" y="107">
          Home
        </text>
        <text
          fill="var(--text-2)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7.5"
          textAnchor="end"
          x="130"
          y="107"
        >
          $850,000
        </text>
      </g>
      <g className="v-csm-row-2">
        <text fontSize="9" x="17" y="126">
          🚗
        </text>
        <text fill="var(--text)" fontSize="7.5" x="33" y="125">
          Car
        </text>
        <text
          fill="var(--text-2)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7.5"
          textAnchor="end"
          x="130"
          y="125"
        >
          $42,000
        </text>
      </g>
      <g className="v-csm-row-3">
        <text fontSize="9" x="17" y="144">
          💰
        </text>
        <text fill="var(--text)" fontSize="7.5" x="33" y="143">
          Savings
        </text>
        <text
          fill="var(--text-2)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7.5"
          textAnchor="end"
          x="130"
          y="143"
        >
          $90,000
        </text>
      </g>
    </g>
  );
}
