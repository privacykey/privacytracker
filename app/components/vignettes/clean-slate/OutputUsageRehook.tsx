import PhoneFrame from "../PhoneFrame";
import CleanSlatePulses from "./CleanSlatePulses";

/**
 * USAGE DATA · track tier — your 11pm peak is read as a weak moment and
 * matched to you, then a push notification is timed to land on your
 * night-time lock screen to pull you back in. A dark lock screen at
 * 11:04 with an App A notification.
 */
export default function OutputUsageRehook() {
  const px = 206;
  const py = 16;
  const pw = 100;
  const sx = px + 6;
  const sw = pw - 12;

  return (
    <g className="v-cs v-cs-usage-track">
      <CleanSlatePulses y={84} />

      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="6.5"
        fontWeight="700"
        letterSpacing="0.5"
        textAnchor="middle"
        x="256"
        y="12"
      >
        ON YOUR PHONE, AT 11PM
      </text>

      {/* Identity match — the nudge is aimed at you specifically. */}
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

      <g className="v-cs-othersite">
        <PhoneFrame
          height={150}
          screenFill="#0b1220"
          width={pw}
          x={px}
          y={py}
        />
        <text
          fill="#ffffff"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="18"
          fontWeight="700"
          textAnchor="middle"
          x="256"
          y="58"
        >
          11:04
        </text>
        <text fill="#94a3b8" fontSize="6.5" textAnchor="middle" x="256" y="69">
          Monday
        </text>
      </g>

      {/* The re-hook notification banner */}
      <g className="v-cs-adslot">
        {/* Light frosted notification — fixed colours so it reads on the
            dark lock screen in both light and dark mode. */}
        <rect
          fill="#f3f4f6"
          height="44"
          rx="8"
          stroke="#cbd5e1"
          width={sw}
          x={sx}
          y={py + 74}
        />
        <rect
          fill="#0d9488"
          height="10"
          rx="2"
          width="10"
          x={sx + 8}
          y={py + 82}
        />
        <text
          fill="#1c1c1e"
          fontSize="6.5"
          fontWeight="700"
          x={sx + 22}
          y={py + 90}
        >
          App A
        </text>
        <text
          fill="#8e8e93"
          fontSize="5.5"
          textAnchor="end"
          x={sx + sw - 8}
          y={py + 90}
        >
          now
        </text>
        <text fill="#475569" fontSize="6.5" x={sx + 8} y={py + 104}>
          Still up? Come back —
        </text>
        <text fill="#475569" fontSize="6.5" x={sx + 8} y={py + 113}>
          3 new updates waiting
        </text>
      </g>
    </g>
  );
}
