/**
 * SEARCH HISTORY · capture motif — a real search field mid-query with a
 * recent-searches history beneath it. Neutral everyday searches (cooking
 * + shopping) that still add up to a clear in-market profile. Bespoke to
 * the clean-slate set.
 */
function ClockGlyph({ x, y }: { x: number; y: number }) {
  return (
    <g
      fill="none"
      stroke="var(--text-3)"
      strokeLinecap="round"
      strokeWidth="1.1"
    >
      <circle cx={x} cy={y} r="3.6" />
      <path d={`M ${x} ${y} L ${x} ${y - 2}`} />
      <path d={`M ${x} ${y} L ${x + 1.8} ${y}`} />
    </g>
  );
}

export default function MotifSearchQuery() {
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

      {/* Search field */}
      <rect
        fill="var(--bg-2, #fff)"
        height="18"
        rx="9"
        stroke="var(--border-strong)"
        width="114"
        x="16"
        y="30"
      />
      <circle
        cx="25"
        cy="38"
        fill="none"
        r="3.2"
        stroke="var(--text-3)"
        strokeWidth="1.4"
      />
      <line
        stroke="var(--text-3)"
        strokeLinecap="round"
        strokeWidth="1.4"
        x1="27.4"
        x2="30"
        y1="40.4"
        y2="43"
      />
      <g className="v-csm-pop">
        <text fill="var(--text)" fontSize="8" x="34" y="43">
          pasta recipes
        </text>
      </g>

      {/* Recent searches — a life laid bare */}
      <text
        fill="var(--text-3)"
        fontSize="6"
        fontWeight="700"
        letterSpacing="0.5"
        x="18"
        y="62"
      >
        RECENT
      </text>
      <g className="v-csm-row-1">
        <ClockGlyph x={23} y={73} />
        <text fill="var(--text-2)" fontSize="7.5" x="33" y="76">
          air fryer reviews
        </text>
      </g>
      <g className="v-csm-row-2">
        <ClockGlyph x={23} y={91} />
        <text fill="var(--text-2)" fontSize="7.5" x="33" y="94">
          best chef knives
        </text>
      </g>
      <g className="v-csm-row-3">
        <ClockGlyph x={23} y={109} />
        <text fill="var(--text-2)" fontSize="7.5" x="33" y="112">
          pizza near me
        </text>
      </g>
    </g>
  );
}
