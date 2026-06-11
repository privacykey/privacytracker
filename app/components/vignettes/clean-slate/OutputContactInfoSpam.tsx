import PhoneFrame from "../PhoneFrame";
import CleanSlatePulses from "./CleanSlatePulses";

/**
 * CONTACT INFO · track tier — the email you gave one app is the
 * universal join key. A week later your inbox fills with marketing from
 * companies you never told. Phone + inbox rows + the shared
 * "matched to you" identity marker.
 */
export default function OutputContactInfoSpam() {
  const px = 206;
  const py = 16;
  const pw = 100;
  const sx = px + 6;
  const sw = pw - 12;

  const mail = [
    { from: "MegaMart", subj: "You're missing out!" },
    { from: "TravelDeals", subj: "Flash sale ends soon" },
    { from: "InsureCo", subj: "Your quote is ready" },
  ];

  return (
    <g className="v-cs v-cs-contactinfo-track">
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
        YOUR INBOX, A WEEK LATER
      </text>

      {/* Identity match — the address IS you; spam lands by name. */}
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
        <text fontSize="9" x={sx + 2} y={py + 32}>
          ✉️
        </text>
        <text
          fill="var(--text-2)"
          fontSize="7.5"
          fontWeight="700"
          x={sx + 14}
          y={py + 31}
        >
          Inbox
        </text>
        <text
          fill="var(--blue, #2563eb)"
          fontSize="6"
          fontWeight="700"
          textAnchor="end"
          x={sx + sw - 2}
          y={py + 31}
        >
          3 new
        </text>
        <line
          stroke="var(--border-strong)"
          x1={sx + 2}
          x2={sx + sw - 2}
          y1={py + 37}
          y2={py + 37}
        />
      </g>

      {/* Marketing mail you never asked for, landing one by one */}
      {mail.map((m, i) => (
        <g className={`v-cs-row v-cs-row-${i + 1}`} key={m.from}>
          <circle
            cx={sx + 5}
            cy={py + 47 + i * 26}
            fill="var(--blue, #2563eb)"
            r="2"
          />
          <text
            fill="var(--text)"
            fontSize="7"
            fontWeight="700"
            x={sx + 11}
            y={py + 50 + i * 26}
          >
            {m.from}
          </text>
          <text
            fill="var(--text-3)"
            fontSize="6"
            x={sx + 11}
            y={py + 59 + i * 26}
          >
            {m.subj}
          </text>
          <line
            stroke="var(--border)"
            x1={sx + 2}
            x2={sx + sw - 2}
            y1={py + 64 + i * 26}
            y2={py + 64 + i * 26}
          />
        </g>
      ))}

      {/* The punchline */}
      <text
        className="v-cs-fade"
        fill="var(--red, #dc2626)"
        fontSize="6"
        fontWeight="700"
        textAnchor="middle"
        x="256"
        y={py + 135}
      >
        you never signed up with these
      </text>
    </g>
  );
}
