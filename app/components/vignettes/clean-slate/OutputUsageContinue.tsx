import CleanSlatePulses from "./CleanSlatePulses";

/**
 * USAGE DATA · linked tier — the calm use: where you left off is kept so
 * the app can drop you back in. A "continue" card with a progress bar.
 * Tied to you, used by App A, not sold.
 */
export default function OutputUsageContinue() {
  return (
    <g className="v-cs v-cs-usage-linked">
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
          Continue reading
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

      {/* Resume card with progress */}
      <g className="v-cs-row v-cs-row-1">
        <path d="M 170 76 L 170 92 L 184 84 Z" fill="var(--blue, #2563eb)" />
        <text fill="var(--text)" fontSize="7.5" fontWeight="600" x="192" y="82">
          The article you were
        </text>
        <text fill="var(--text-3)" fontSize="7" x="192" y="92">
          reading · 60% in
        </text>
      </g>
      <g className="v-cs-row v-cs-row-2">
        <rect
          fill="var(--surface-active)"
          height="6"
          rx="3"
          width="136"
          x="164"
          y="104"
        />
        <rect
          fill="var(--blue, #2563eb)"
          height="6"
          rx="3"
          width="82"
          x="164"
          y="104"
        />
      </g>

      <text
        className="v-cs-fade"
        fill="var(--orange, #ea580c)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="130"
      >
        Resumes for you · not sold
      </text>
    </g>
  );
}
