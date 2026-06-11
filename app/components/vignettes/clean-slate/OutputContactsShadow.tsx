import CleanSlatePulses from "./CleanSlatePulses";

/**
 * CONTACTS · output — "A profile on someone who never signed up".
 *
 * Makes the "shadow profile" idea concrete: a named non-user (Sarah)
 * whom App A nonetheless holds a dossier on — phone, email, workplace —
 * tagged NON-USER, with the footer spelling out how it was assembled
 * (stitched from many people's uploaded address books, including yours).
 * The point lands without the jargon "shadow profile".
 */
export default function OutputContactsShadow() {
  return (
    <g className="v-cs v-cs-contacts">
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
        WHAT THEY BUILD
      </text>

      <g className="v-cs-surface">
        <rect
          fill="var(--bg-2, #fff)"
          height="124"
          rx="10"
          stroke="var(--border-strong)"
          width="152"
          x="156"
          y="36"
        />

        {/* The non-user this dossier is about. */}
        <circle cx="170" cy="52" fill="var(--text-3)" r="7" />
        <text
          fill="#ffffff"
          fontSize="8"
          fontWeight="700"
          textAnchor="middle"
          x="170"
          y="55"
        >
          S
        </text>
        <text fill="var(--text)" fontSize="8.5" fontWeight="700" x="182" y="50">
          Sarah M.
        </text>
        <text fill="var(--text-3)" fontSize="6" x="182" y="60">
          never installed App A
        </text>

        {/* NON-USER tag */}
        <rect
          fill="none"
          height="13"
          rx="6.5"
          stroke="var(--red, #dc2626)"
          strokeWidth="1.2"
          width="50"
          x="250"
          y="44"
        />
        <text
          fill="var(--red, #dc2626)"
          fontSize="6.5"
          fontWeight="800"
          textAnchor="middle"
          x="275"
          y="53"
        >
          NON-USER
        </text>

        <line stroke="var(--border)" x1="164" x2="300" y1="68" y2="68" />
      </g>

      {/* What they nonetheless hold on her. */}
      <g className="v-cs-row v-cs-row-1">
        <text fill="var(--text-3)" fontSize="7.5" x="164" y="86">
          Phone
        </text>
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7"
          textAnchor="end"
          x="300"
          y="86"
        >
          +61 4•• ••• 218
        </text>
      </g>
      <g className="v-cs-row v-cs-row-2">
        <text fill="var(--text-3)" fontSize="7.5" x="164" y="104">
          Email
        </text>
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7"
          textAnchor="end"
          x="300"
          y="104"
        >
          s••••@gmail.com
        </text>
      </g>
      <g className="v-cs-row v-cs-row-3">
        <text fill="var(--text-3)" fontSize="7.5" x="164" y="122">
          Works at
        </text>
        <text
          fill="var(--text)"
          fontSize="7.5"
          textAnchor="end"
          x="300"
          y="122"
        >
          Acme Pty
        </text>
      </g>

      {/* The mechanism — the punchline, revealed last. */}
      <text
        className="v-cs-fade"
        fill="var(--text-2)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="146"
      >
        Stitched from 14 address books — incl. yours
      </text>
    </g>
  );
}
