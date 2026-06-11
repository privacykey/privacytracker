import CleanSlatePulses from "./CleanSlatePulses";

/**
 * LOCATION · linked tier — the app uses your saved places for your own
 * convenience: a personalised commute card ("Home → Work, 18 min").
 * Tied to you, used by App A, not sold.
 */
export default function OutputLocationLinkedCommute() {
  return (
    <g className="v-cs v-cs-linked-loc">
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
          Good morning
        </text>
        <text fill="var(--text-3)" fontSize="6" textAnchor="end" x="300" y="53">
          App A
        </text>
        <line stroke="var(--border)" x1="164" x2="300" y1="60" y2="60" />
      </g>

      {/* Commute tile from your saved places */}
      <g className="v-cs-row v-cs-row-1">
        <rect
          fill="var(--surface)"
          height="32"
          rx="6"
          stroke="var(--border)"
          width="136"
          x="164"
          y="68"
        />
        <text fontSize="11" x="170" y="89">
          🏠
        </text>
        <text fill="var(--text-2)" fontSize="6.5" x="184" y="82">
          Home
        </text>
        <line
          stroke="var(--border-strong)"
          strokeDasharray="2 2"
          x1="206"
          x2="248"
          y1="84"
          y2="84"
        />
        <text fontSize="11" x="250" y="89">
          💼
        </text>
        <text fill="var(--text-2)" fontSize="6.5" x="264" y="82">
          Work
        </text>
        <text
          fill="var(--text)"
          fontSize="7"
          fontWeight="700"
          textAnchor="end"
          x="294"
          y="92"
        >
          18 min
        </text>
      </g>

      <g className="v-cs-row v-cs-row-2">
        <text fill="var(--text-2)" fontSize="7" x="164" y="114">
          Leave by 8:05 · your usual route
        </text>
      </g>

      <text
        className="v-cs-fade"
        fill="var(--orange, #ea580c)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="132"
      >
        From your saved places · App A only
      </text>
    </g>
  );
}
