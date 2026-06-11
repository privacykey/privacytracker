import CleanSlatePulses from "./CleanSlatePulses";

/**
 * SEARCH HISTORY · linked tier — your history stays in App A and just
 * makes search faster: typing "fl" surfaces your recent queries as
 * autocomplete. Tied to you, used by the app, not sold.
 */
export default function OutputSearchLinked() {
  return (
    <g className="v-cs v-cs-search-linked">
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
        {/* tier tag */}
        <rect
          fill="none"
          height="13"
          rx="6.5"
          stroke="var(--orange, #ea580c)"
          strokeWidth="1.2"
          width="46"
          x="252"
          y="42"
        />
        <text
          fill="var(--orange, #ea580c)"
          fontSize="6.5"
          fontWeight="800"
          textAnchor="middle"
          x="275"
          y="51"
        >
          LINKED
        </text>
        {/* search field with cursor */}
        <rect
          fill="var(--surface)"
          height="16"
          rx="8"
          stroke="var(--border-strong)"
          width="78"
          x="164"
          y="44"
        />
        <circle
          cx="172"
          cy="52"
          fill="none"
          r="3"
          stroke="var(--text-3)"
          strokeWidth="1.3"
        />
        <line
          stroke="var(--text-3)"
          strokeLinecap="round"
          strokeWidth="1.3"
          x1="174.2"
          x2="176.5"
          y1="54.2"
          y2="56.5"
        />
        <text fill="var(--text)" fontSize="8" x="181" y="57">
          pa
        </text>
        <rect
          className="v-cursor-x"
          fill="var(--text)"
          height="9"
          width="1"
          x="192"
          y="49"
        />
        <line stroke="var(--border)" x1="164" x2="300" y1="66" y2="66" />
      </g>

      {/* Autocomplete from your own history */}
      <g className="v-cs-row v-cs-row-1">
        <text fill="var(--text)" fontSize="8" x="170" y="82">
          pasta recipes
        </text>
        <text fill="var(--text-3)" fontSize="6" textAnchor="end" x="300" y="82">
          recent
        </text>
      </g>
      <g className="v-cs-row v-cs-row-2">
        <text fill="var(--text-2)" fontSize="8" x="170" y="99">
          pad thai near me
        </text>
      </g>
      <g className="v-cs-row v-cs-row-3">
        <text fill="var(--text-2)" fontSize="8" x="170" y="116">
          pancake recipe
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
        Saved to your account · App A only
      </text>
    </g>
  );
}
