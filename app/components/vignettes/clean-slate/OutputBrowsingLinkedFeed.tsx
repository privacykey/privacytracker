import CleanSlatePulses from "./CleanSlatePulses";

/**
 * BROWSING · linked tier — your views tune your own feed inside App A.
 * "Because you viewed running" → two recommended items. Personalisation
 * that stays in the app, not sold to advertisers.
 */
export default function OutputBrowsingLinkedFeed() {
  return (
    <g className="v-cs v-cs-linked-browse">
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
          height="116"
          rx="10"
          stroke="var(--border-strong)"
          width="152"
          x="156"
          y="36"
        />
        <text fill="var(--text)" fontSize="8" fontWeight="700" x="164" y="53">
          Your feed
        </text>
        <text fill="var(--text-3)" fontSize="6" textAnchor="end" x="300" y="53">
          App A
        </text>
        <line stroke="var(--border)" x1="164" x2="300" y1="60" y2="60" />
        <text fill="var(--text-3)" fontSize="6.5" x="164" y="72">
          Because you viewed running:
        </text>
      </g>

      <g className="v-cs-row v-cs-row-1">
        <rect
          fill="var(--surface)"
          height="18"
          rx="5"
          width="136"
          x="164"
          y="78"
        />
        <text fontSize="11" x="169" y="91">
          👟
        </text>
        <text fill="var(--text)" fontSize="7.5" x="184" y="90">
          Trail Runner
        </text>
        <text
          fill="var(--text-2)"
          fontSize="7"
          fontWeight="700"
          textAnchor="end"
          x="294"
          y="90"
        >
          for you
        </text>
      </g>
      <g className="v-cs-row v-cs-row-2">
        <rect
          fill="var(--surface)"
          height="18"
          rx="5"
          width="136"
          x="164"
          y="100"
        />
        <text fontSize="10" x="169" y="113">
          🏃
        </text>
        <text fill="var(--text)" fontSize="7.5" x="184" y="112">
          Marathon training plan
        </text>
      </g>

      <text
        className="v-cs-fade"
        fill="var(--orange, #ea580c)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="136"
      >
        Tailored for you inside App A
      </text>
    </g>
  );
}
