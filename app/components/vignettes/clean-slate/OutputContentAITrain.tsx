import CleanSlatePulses from "./CleanSlatePulses";

/**
 * USER CONTENT · track tier — your photos are pulled into a model's
 * training set. A dense grid of dataset tiles (a few highlighted as
 * yours) sits among millions, and the concrete payoff: it learns to
 * recognise your face.
 */
export default function OutputContentAITrain() {
  const cols = 13;
  const rows = 4;
  const mine = new Set([5, 19, 31, 44]);
  const tiles = Array.from({ length: cols * rows }, (_, i) => ({
    x: 164 + (i % cols) * 10.3,
    y: 66 + Math.floor(i / cols) * 10,
    mine: mine.has(i),
  }));

  return (
    <g className="v-cs v-cs-content-track">
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
        WHAT HAPPENS NEXT
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
        <text fill="var(--text)" fontSize="8" fontWeight="700" x="164" y="53">
          Pulled into a training set
        </text>
        <line stroke="var(--border)" x1="164" x2="300" y1="59" y2="59" />
      </g>

      {/* Dataset — your photos among millions; yours highlighted */}
      <g className="v-cs-fade">
        {tiles.map((t) => (
          <rect
            fill={t.mine ? "var(--blue, #2563eb)" : "var(--border-strong)"}
            height="8"
            key={`${t.x}-${t.y}`}
            rx="1.5"
            width="8"
            x={t.x}
            y={t.y}
          />
        ))}
      </g>

      <text
        className="v-cs-fade"
        fill="var(--text)"
        fontSize="7.5"
        fontWeight="700"
        x="164"
        y="120"
      >
        Your 2,318 photos · 1 set of 50M
      </text>
      <text
        className="v-cs-fade"
        fill="var(--red, #dc2626)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="134"
      >
        → trained to recognise your face
      </text>
    </g>
  );
}
