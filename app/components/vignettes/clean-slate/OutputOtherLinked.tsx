import CleanSlatePulses from "./CleanSlatePulses";

/**
 * OTHER DATA · linked tier — the calm version. The unnamed data sits in
 * your account inside App A, used "for app functionality" — which is all
 * the label says. Tied to you, kept in-app, not passed along.
 */
export default function OutputOtherLinked() {
  return (
    <g className="v-cs v-cs-other-linked">
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
          Your account
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

      {/* The unnamed blob, on file with your account */}
      <g className="v-cs-row v-cs-row-1">
        <rect
          fill="none"
          height="14"
          rx="7"
          stroke="var(--text-3)"
          strokeDasharray="3 2.5"
          width="78"
          x="164"
          y="67"
        />
        <text
          fill="var(--text-2)"
          fontSize="6.5"
          fontWeight="700"
          textAnchor="middle"
          x="203"
          y="77"
        >
          Other app data
        </text>
        <text fill="var(--text-3)" fontSize="7" x="250" y="77">
          on file
        </text>
      </g>

      <g className="v-cs-row v-cs-row-2">
        <text fontSize="8" x="164" y="98">
          ⚙️
        </text>
        <text fill="var(--text)" fontSize="7" x="177" y="97">
          Used by app features
        </text>
      </g>
      <g className="v-cs-row v-cs-row-3">
        <text fontSize="8" x="164" y="112">
          📁
        </text>
        <text fill="var(--text)" fontSize="7" x="177" y="111">
          Saved with your profile
        </text>
      </g>

      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="6"
        x="164"
        y="125"
      >
        "app functionality" — that's all it says
      </text>

      <text
        className="v-cs-fade"
        fill="var(--orange, #ea580c)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="140"
      >
        Stays in App A · not sold
      </text>
    </g>
  );
}
