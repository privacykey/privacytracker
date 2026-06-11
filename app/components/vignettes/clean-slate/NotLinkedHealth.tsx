/**
 * HEALTH · not-linked tier — name stripped at source, then your sample
 * is one bar in a distribution of 50,000. Your reading is somewhere in
 * the histogram, but unmarked — it can't be pulled back out as yours.
 */
export default function NotLinkedHealth() {
  // A rough bell-shaped distribution; your bin is not highlighted.
  const dist = [6, 12, 22, 34, 30, 20, 11, 6];

  return (
    <g className="v-cs v-cs-nl-health">
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
        Health sample
      </text>
      <line stroke="var(--border)" x1="18" x2="138" y1="61" y2="61" />
      <g className="v-cs-redact">
        <text fill="var(--text)" fontSize="7.5" x="18" y="78">
          Name: You
        </text>
      </g>
      <line
        className="v-cs-strike"
        stroke="var(--red, #dc2626)"
        strokeWidth="1.4"
        x1="16"
        x2="74"
        y1="75"
        y2="75"
      />
      <text fill="var(--text-2)" fontSize="7.5" x="18" y="98">
        Resting HR: 72
      </text>
      <text fill="var(--text-2)" fontSize="7.5" x="18" y="116">
        Age band: 30–39
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
          Pooled into a distribution
        </text>
        <line stroke="var(--border)" x1="175" x2="303" y1="61" y2="61" />
        {/* histogram — your bin is not marked */}
        {dist.map((h, i) => (
          <rect
            fill="var(--pink, #ec4899)"
            fillOpacity="0.55"
            height={h}
            key={`b-${i}`}
            rx="1.5"
            width="13"
            x={176 + i * 16}
            y={116 - h}
          />
        ))}
        <line stroke="var(--border)" x1="174" x2="304" y1="117" y2="117" />
        <text fill="var(--text)" fontSize="8" fontWeight="700" x="175" y="132">
          1 of 50,000 samples
        </text>
        <text fill="var(--text-3)" fontSize="6.5" x="175" y="143">
          drives the average — not your record
        </text>
      </g>
    </g>
  );
}
