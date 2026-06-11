import CleanSlatePulses from "./CleanSlatePulses";

/**
 * SENSITIVE INFO · linked tier — the calm use. Your inferred beliefs are
 * tied to you, but stay inside App A to tune what you see; nothing is
 * packaged or sold. A "Your profile" card with the trait used to tailor
 * the in-app feed, and a clear "stays in App A · not sold" footer.
 */
export default function OutputSensitiveLinked() {
  return (
    <g className="v-cs v-cs-sensitive-linked">
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
          Your profile
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

      {/* The sensitive trait, held against you (in-app only) */}
      <g className="v-cs-row v-cs-row-1">
        <rect
          fill="rgba(147,51,234,0.16)"
          height="14"
          rx="7"
          stroke="#9333ea"
          width="62"
          x="164"
          y="68"
        />
        <text
          fill="#9333ea"
          fontSize="7"
          fontWeight="700"
          textAnchor="middle"
          x="195"
          y="78"
        >
          Faith
        </text>
        <text fill="var(--text-3)" fontSize="7" x="232" y="78">
          held by App A
        </text>
      </g>

      {/* Used to tune the in-app feed */}
      <g className="v-cs-row v-cs-row-2">
        <text fill="var(--text)" fontSize="7.5" fontWeight="600" x="164" y="98">
          Tunes the content
        </text>
        <text
          fill="var(--text)"
          fontSize="7.5"
          fontWeight="600"
          x="164"
          y="108"
        >
          you see in App A
        </text>
        <rect
          fill="var(--surface-active)"
          height="6"
          rx="3"
          width="136"
          x="164"
          y="116"
        />
        <rect
          fill="#9333ea"
          fillOpacity="0.7"
          height="6"
          rx="3"
          width="74"
          x="164"
          y="116"
        />
      </g>

      <text
        className="v-cs-fade"
        fill="var(--orange, #ea580c)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="138"
      >
        Stays in App A · not sold
      </text>
    </g>
  );
}
