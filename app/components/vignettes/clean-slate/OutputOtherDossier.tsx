import CleanSlatePulses from "./CleanSlatePulses";

/**
 * OTHER DATA · track tier — whatever it is, it's filed with everything
 * else they hold on you. A folder ("Your file") lists the data you'd
 * expect — location, purchases, contacts — and then an "Other" row whose
 * contents are just a redaction bar. It's matched to you and travels
 * with the rest; they don't have to say what it is.
 */
export default function OutputOtherDossier() {
  const known = [
    { label: "Location", y: 58 },
    { label: "Purchases", y: 72 },
    { label: "Contacts", y: 86 },
  ];

  return (
    <g className="v-cs v-cs-other-track">
      <CleanSlatePulses y={84} />

      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="6.5"
        fontWeight="700"
        letterSpacing="0.5"
        textAnchor="middle"
        x="256"
        y="10"
      >
        ADDED TO YOUR FILE
      </text>

      {/* Identity match — the unnamed data is still tied to you. */}
      <g className="v-cs-fade">
        <circle
          cx="176"
          cy="84"
          fill="var(--blue-soft, #dbeafe)"
          r="11"
          stroke="var(--blue, #2563eb)"
          strokeWidth="1.1"
        />
        <text fontSize="12" textAnchor="middle" x="176" y="89">
          🧑
        </text>
        <text
          fill="var(--blue, #2563eb)"
          fontSize="5.5"
          fontWeight="700"
          textAnchor="middle"
          x="176"
          y="103"
        >
          matched to you
        </text>
      </g>

      {/* The folder */}
      <g className="v-cs-surface">
        <rect
          fill="var(--surface-active)"
          height="14"
          rx="3"
          stroke="var(--border-strong)"
          width="36"
          x="208"
          y="17"
        />
        <rect
          fill="var(--bg-2, #fff)"
          height="136"
          rx="10"
          stroke="var(--border-strong)"
          width="104"
          x="202"
          y="24"
        />
        <text
          fill="var(--text-3)"
          fontSize="6.5"
          fontWeight="700"
          letterSpacing="0.5"
          x="210"
          y="40"
        >
          🗂 YOUR FILE
        </text>
        <line stroke="var(--border)" x1="210" x2="298" y1="46" y2="46" />
      </g>

      {/* The data you'd expect to find */}
      {known.map((k, i) => (
        <g className={`v-cs-row v-cs-row-${i + 1}`} key={k.label}>
          <text fill="var(--text-2)" fontSize="7" x="212" y={k.y}>
            {k.label}
          </text>
          <text
            fill="var(--green, #16a34a)"
            fontSize="7"
            fontWeight="700"
            textAnchor="end"
            x="296"
            y={k.y}
          >
            ✓
          </text>
        </g>
      ))}

      <line
        stroke="var(--border)"
        strokeDasharray="2 2"
        x1="210"
        x2="298"
        y1="94"
        y2="94"
      />

      {/* …and the row no one will explain */}
      <g className="v-cs-row v-cs-row-4">
        <text fill="var(--text)" fontSize="7" fontWeight="700" x="212" y="108">
          Other
        </text>
        <rect
          fill="var(--text-3)"
          fillOpacity="0.55"
          height="8"
          rx="4"
          width="38"
          x="244"
          y="101"
        />
        <text
          fill="var(--red, #dc2626)"
          fontSize="8"
          fontWeight="800"
          textAnchor="end"
          x="296"
          y="108"
        >
          ?
        </text>
      </g>

      <g className="v-cs-fade">
        <text
          fill="var(--red, #dc2626)"
          fontSize="6"
          fontWeight="700"
          textAnchor="middle"
          x="254"
          y="126"
        >
          contents not disclosed
        </text>
        <text
          fill="var(--text-3)"
          fontSize="5.5"
          textAnchor="middle"
          x="254"
          y="140"
        >
          travels with everything else
        </text>
      </g>
    </g>
  );
}
