import CleanSlatePulses from "./CleanSlatePulses";

/**
 * DIAGNOSTICS · linked tier — the calm use: your crash is a support
 * ticket on your account, and the loop closes with a fix shipped to
 * your device. Tied to you so they can fix *your* bug; not passed on.
 */
export default function OutputDiagSupport() {
  return (
    <g className="v-cs v-cs-diag-linked">
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
          App A support
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

      {/* Your crash, ticketed */}
      <g className="v-cs-row v-cs-row-1">
        <text fontSize="8" x="164" y="76">
          ⚠️
        </text>
        <text fill="var(--text)" fontSize="7.5" fontWeight="700" x="177" y="75">
          Crash #4821 — login
        </text>
        <text fill="var(--text-3)" fontSize="6.5" x="177" y="85">
          from your device · your account
        </text>
      </g>

      {/* The loop closes */}
      <g className="v-cs-row v-cs-row-2">
        <text fontSize="8" x="164" y="103">
          🔧
        </text>
        <text fill="var(--text)" fontSize="7" x="177" y="102">
          Bug reproduced &amp; fixed
        </text>
      </g>
      <g className="v-cs-row v-cs-row-3">
        <text fontSize="8" x="164" y="117">
          ✅
        </text>
        <text fill="var(--text)" fontSize="7" x="177" y="116">
          Update 2.1.4 sent to you
        </text>
      </g>

      <text
        className="v-cs-fade"
        fill="var(--orange, #ea580c)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="138"
      >
        Used to fix your bug · not sold
      </text>
    </g>
  );
}
