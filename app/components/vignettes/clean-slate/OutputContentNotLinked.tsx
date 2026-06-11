/**
 * USER CONTENT · not-linked tier — a photo has its owner and geotag
 * stripped at source, then the bare pixels join an anonymous training
 * pool. Same dataset grid as the track tier, but every tile is identical
 * grey: yours can't be picked out.
 */
export default function OutputContentNotLinked() {
  const cols = 14;
  const rows = 3;
  const tiles = Array.from({ length: cols * rows }, (_, i) => ({
    x: 174 + (i % cols) * 9,
    y: 70 + Math.floor(i / cols) * 9,
  }));

  return (
    <g className="v-cs v-cs-content-nl">
      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="6.5"
        fontWeight="700"
        letterSpacing="0.5"
        textAnchor="middle"
        x="239"
        y="30"
      >
        WHAT'S STORED
      </text>

      {/* Raw upload */}
      <rect
        fill="var(--bg-2, #fff)"
        height="108"
        rx="9"
        stroke="var(--border-strong)"
        width="140"
        x="8"
        y="40"
      />
      <text fill="var(--text-2)" fontSize="7.5" fontWeight="700" x="18" y="56">
        Photo upload
      </text>
      <line stroke="var(--border)" x1="18" x2="138" y1="61" y2="61" />
      <rect fill="#bfe3ff" height="24" rx="3" width="30" x="18" y="68" />
      <circle cx="33" cy="78" fill="#9ca3af" r="3.5" />

      <g className="v-cs-redact">
        <text fill="var(--text)" fontSize="7" x="56" y="76">
          Owner: You
        </text>
      </g>
      <line
        className="v-cs-strike"
        stroke="var(--red, #dc2626)"
        strokeWidth="1.4"
        x1="54"
        x2="108"
        y1="73"
        y2="73"
      />
      <g className="v-cs-redact">
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="6.5"
          x="56"
          y="90"
        >
          Geotag −33.86
        </text>
      </g>
      <line
        className="v-cs-strike"
        stroke="var(--red, #dc2626)"
        strokeWidth="1.4"
        x1="54"
        x2="122"
        y1="87"
        y2="87"
      />
      <text
        fill="var(--text-2)"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        x="18"
        y="108"
      >
        + image pixels
      </text>

      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="12"
        x="150"
        y="98"
      >
        →
      </text>

      {/* Pooled, anonymous dataset */}
      <g className="v-cs-fade">
        <rect
          fill="var(--bg-2, #fff)"
          height="108"
          rx="9"
          stroke="var(--border-strong)"
          width="146"
          x="166"
          y="40"
        />
        <text fill="var(--text)" fontSize="7.5" fontWeight="700" x="175" y="56">
          Pooled to train
        </text>
        <line stroke="var(--border)" x1="175" x2="303" y1="61" y2="61" />
        {tiles.map((t) => (
          <rect
            fill="var(--border-strong)"
            height="7"
            key={`${t.x}-${t.y}`}
            rx="1.5"
            width="7"
            x={t.x}
            y={t.y}
          />
        ))}
        <text fill="var(--text)" fontSize="8" fontWeight="700" x="175" y="116">
          1 of 10M images
        </text>
        <text fill="var(--text-3)" fontSize="6.5" x="175" y="128">
          no owner · no location
        </text>
      </g>
    </g>
  );
}
