import PhoneFrame from "../PhoneFrame";
import CleanSlatePulses from "./CleanSlatePulses";

/**
 * SENSITIVE INFO · track tier — your inferred beliefs are packaged into a
 * sellable audience segment and made available to advertisers. You see a
 * "Sponsored" post in an unrelated app; the "Why this ad?" panel quietly
 * names the belief segment you were sorted into. Mirrors the browsing /
 * search retarget so the tracking stories rhyme, with the same
 * "matched to you" identity marker.
 */
export default function OutputSensitiveSegment() {
  const px = 206;
  const py = 16;
  const pw = 100;
  const sx = px + 6;
  const sw = pw - 12;

  return (
    <g className="v-cs v-cs-sensitive-track">
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
        SOLD AS A SEGMENT
      </text>

      {/* Identity match — the segment is tied to you, not anonymous. */}
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

        {/* Unrelated app — a music app, nothing to do with beliefs */}
        <text fontSize="9" x={sx + 2} y={py + 32}>
          🎵
        </text>
        <text
          fill="var(--text-2)"
          fontSize="7.5"
          fontWeight="700"
          x={sx + 14}
          y={py + 31}
        >
          Music
        </text>
        <rect
          fill="var(--surface-active)"
          height="5"
          rx="2"
          width={sw - 4}
          x={sx + 2}
          y={py + 39}
        />
      </g>

      {/* Sponsored slot */}
      <g className="v-cs-adslot">
        <rect
          fill="var(--blue-soft, #dbeafe)"
          height="34"
          rx="6"
          stroke="var(--blue, #2563eb)"
          strokeWidth="1.2"
          width={sw}
          x={sx}
          y={py + 48}
        />
        <text
          fill="var(--blue, #2563eb)"
          fontSize="5.5"
          fontWeight="700"
          letterSpacing="0.4"
          x={sx + 4}
          y={py + 58}
        >
          SPONSORED
        </text>
        <text
          fill="var(--text)"
          fontSize="7.5"
          fontWeight="700"
          x={sx + 4}
          y={py + 70}
        >
          An ad chosen
        </text>
        <text
          fill="var(--text)"
          fontSize="7.5"
          fontWeight="700"
          x={sx + 4}
          y={py + 79}
        >
          for your profile
        </text>

        {/* "Why this ad?" panel — names the belief segment you were sold into */}
        <rect
          fill="var(--surface)"
          height="42"
          rx="6"
          stroke="var(--border-strong)"
          width={sw}
          x={sx}
          y={py + 88}
        />
        <text
          fill="var(--text-3)"
          fontSize="5.5"
          fontWeight="700"
          x={sx + 5}
          y={py + 99}
        >
          Why this ad?
        </text>
        <text fill="var(--text)" fontSize="6.5" x={sx + 5} y={py + 110}>
          You're in segment:
        </text>
        <text
          fill="#9333ea"
          fontSize="6.5"
          fontWeight="800"
          x={sx + 5}
          y={py + 120}
        >
          Faith · Leaning
        </text>
      </g>
    </g>
  );
}
