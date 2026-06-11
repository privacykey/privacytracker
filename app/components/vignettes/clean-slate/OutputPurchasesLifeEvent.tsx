import PhoneFrame from "../PhoneFrame";
import CleanSlatePulses from "./CleanSlatePulses";

/**
 * PURCHASES · track tier — a few items are read as a life event (a new
 * puppy), matched to you, and pet-shop ads start following you into a
 * totally unrelated app. Mirrors the search/browsing retarget styling so
 * the "tracking" stories rhyme.
 */
export default function OutputPurchasesLifeEvent() {
  const px = 206;
  const py = 16;
  const pw = 100;
  const sx = px + 6;
  const sw = pw - 12;

  return (
    <g className="v-cs v-cs-purchases-track">
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
        A DIFFERENT, UNRELATED APP
      </text>

      {/* Identity match — the life event is pinned to you. */}
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
        <PhoneFrame height={150} width={pw} x={px} y={py} />

        {/* Unrelated app — a puzzle game */}
        <text fontSize="9" x={sx + 2} y={py + 32}>
          🧩
        </text>
        <text
          fill="var(--text-2)"
          fontSize="7.5"
          fontWeight="700"
          x={sx + 14}
          y={py + 31}
        >
          Sudoku
        </text>
        <rect
          fill="var(--surface-active)"
          height="5"
          rx="2"
          width={sw - 4}
          x={sx + 2}
          y={py + 39}
        />
        <rect
          fill="var(--surface-active)"
          height="5"
          rx="2"
          width={sw - 18}
          x={sx + 2}
          y={py + 45}
        />
      </g>

      {/* The retargeted ad — pet kit, because they spotted the puppy. */}
      <g className="v-cs-adslot">
        <rect
          fill="var(--blue-soft, #dbeafe)"
          height="48"
          rx="6"
          stroke="var(--blue, #2563eb)"
          strokeWidth="1.2"
          width={sw}
          x={sx}
          y={py + 51}
        />
        <text
          fill="var(--blue, #2563eb)"
          fontSize="5.5"
          fontWeight="700"
          letterSpacing="0.4"
          x={sx + 4}
          y={py + 61}
        >
          AD · FOR YOU
        </text>
        <text fontSize="19" x={sx + 4} y={py + 85}>
          🐶
        </text>
        <text
          fill="var(--text)"
          fontSize="7.5"
          fontWeight="700"
          x={sx + 28}
          y={py + 77}
        >
          Puppy gear
        </text>
        <text
          fill="var(--text)"
          fontSize="8"
          fontWeight="800"
          x={sx + 28}
          y={py + 89}
        >
          20% off
        </text>
      </g>
    </g>
  );
}
