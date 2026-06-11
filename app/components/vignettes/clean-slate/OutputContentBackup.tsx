import CleanSlatePulses from "./CleanSlatePulses";

/**
 * USER CONTENT · linked tier — the calm use: your photos are simply
 * backed up to your own account library, synced across your devices.
 * Tied to you, kept by App A, not used to train and not sold.
 */
export default function OutputContentBackup() {
  return (
    <g className="v-cs v-cs-content-linked">
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
          Your library
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

      {/* Cloud backup */}
      <g className="v-cs-row v-cs-row-1">
        <path
          d="M 178 92 a 9 9 0 0 1 1 -17 a 11 11 0 0 1 21 2 a 8 8 0 0 1 -1 15 Z"
          fill="var(--blue-soft, #dbeafe)"
          stroke="var(--blue, #2563eb)"
          strokeWidth="1.2"
        />
        <path
          d="M 188 80 L 188 89 M 184 84 L 188 80 L 192 84"
          fill="none"
          stroke="var(--blue, #2563eb)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.4"
        />
        <text fill="var(--text)" fontSize="8" fontWeight="600" x="210" y="82">
          2,318 photos
        </text>
        <text fill="var(--text-3)" fontSize="7" x="210" y="93">
          backed up · synced
        </text>
      </g>
      <g className="v-cs-row v-cs-row-2">
        <text fill="var(--text-3)" fontSize="7.5" x="164" y="114">
          Access
        </text>
        <text
          fill="var(--text)"
          fontSize="7.5"
          textAnchor="end"
          x="300"
          y="114"
        >
          just you
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
        Backed up for you · not trained, not sold
      </text>
    </g>
  );
}
