import CleanSlatePulses from "./CleanSlatePulses";

/**
 * LOCATION · output — "Home + daily pattern".
 *
 * Raw location history resolves into two things at once: the address
 * you sleep at (top), and the routine layered on top of it (beneath) —
 * when you leave, where you go, when you're reliably away. The street
 * address is stamped IDENTIFIED; the pattern rows cascade in below it.
 * No verdict badge on the pattern — the rows speak for themselves.
 */
export default function OutputLocationHome() {
  return (
    <g className="v-cs v-cs-loc-home">
      <CleanSlatePulses y={60} />

      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="6.5"
        fontWeight="700"
        letterSpacing="0.6"
        x="160"
        y="18"
      >
        WHAT THEY LEARN
      </text>

      <g className="v-cs-surface">
        <rect
          fill="var(--bg-2, #fff)"
          height="128"
          rx="10"
          stroke="var(--border-strong)"
          width="152"
          x="156"
          y="24"
        />
        {/* Divider between the address and the routine layered on it. */}
        <line stroke="var(--border)" x1="164" x2="300" y1="63" y2="63" />
      </g>

      {/* Home address (top) */}
      <g className="v-cs-row v-cs-row-1">
        <text fontSize="10" x="164" y="42">
          🏠
        </text>
        <text
          fill="var(--text-3)"
          fontSize="6.5"
          fontWeight="700"
          letterSpacing="0.5"
          x="182"
          y="40"
        >
          HOME ADDRESS
        </text>
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="11"
          fontWeight="700"
          x="164"
          y="55"
        >
          14 Maple St, Apt 3
        </text>
      </g>

      {/* Daily pattern (beneath) */}
      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="6.5"
        fontWeight="700"
        letterSpacing="0.5"
        x="164"
        y="77"
      >
        DAILY PATTERN
      </text>

      <g className="v-cs-row v-cs-row-2">
        <text fontSize="8" x="166" y="93">
          🏠
        </text>
        <text fill="var(--text)" fontSize="8" x="182" y="93">
          Leaves home
        </text>
        <text
          fill="var(--text-3)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="8"
          textAnchor="end"
          x="300"
          y="93"
        >
          Mon–Fri 08:15
        </text>
      </g>
      <g className="v-cs-row v-cs-row-3">
        <text fontSize="8" x="166" y="111">
          🏋️
        </text>
        <text fill="var(--text)" fontSize="8" x="182" y="111">
          Gym, 5th Ave
        </text>
        <text
          fill="var(--text-3)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="8"
          textAnchor="end"
          x="300"
          y="111"
        >
          Tue/Thu 18:00
        </text>
      </g>
      <g className="v-cs-row v-cs-row-4">
        <text fontSize="8" x="166" y="129">
          🌙
        </text>
        <text fill="var(--text)" fontSize="8" x="182" y="129">
          Home for night
        </text>
        <text
          fill="var(--text-3)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="8"
          textAnchor="end"
          x="300"
          y="129"
        >
          by 19:30
        </text>
      </g>

      {/* Stamp punctuates the address (top-right of the card). */}
      <g className="v-cs-stamp">
        <rect
          fill="none"
          height="11"
          rx="2.5"
          stroke="var(--red, #dc2626)"
          strokeWidth="1.2"
          width="46"
          x="254"
          y="30"
        />
        <text
          fill="var(--red, #dc2626)"
          fontSize="6.5"
          fontWeight="800"
          letterSpacing="0.4"
          textAnchor="middle"
          x="277"
          y="38"
        >
          IDENTIFIED
        </text>
      </g>
    </g>
  );
}
