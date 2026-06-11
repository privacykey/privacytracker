/**
 * FINANCIAL · not-linked tier — name + card struck at source, then the
 * purchase becomes one tick in an aggregate spend stat for the category.
 * No buyer attached; it only moves a daily total.
 */
export default function NotLinkedFinancial() {
  const dots = Array.from({ length: 40 }, (_, i) => ({
    cx: 178 + (i % 10) * 13,
    cy: 78 + Math.floor(i / 10) * 11,
  }));

  return (
    <g className="v-cs v-cs-nl-financial">
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
        Transaction
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
      <g className="v-cs-redact">
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7"
          x="18"
          y="97"
        >
          Card •••• 4242
        </text>
      </g>
      <line
        className="v-cs-strike"
        stroke="var(--red, #dc2626)"
        strokeWidth="1.4"
        x1="16"
        x2="96"
        y1="94"
        y2="94"
      />
      <text fill="var(--text-2)" fontSize="7.5" x="18" y="116">
        $42.00 · groceries
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
          Pooled into a daily total
        </text>
        <line stroke="var(--border)" x1="175" x2="303" y1="61" y2="61" />
        <text fill="var(--text-3)" fontSize="6.5" x="175" y="74">
          Groceries · AU · today
        </text>
        {dots.map((d) => (
          <circle
            cx={d.cx}
            cy={d.cy}
            fill="#0369a1"
            fillOpacity="0.5"
            key={`${d.cx}-${d.cy}`}
            r="1.8"
          />
        ))}
        <text fill="var(--text)" fontSize="8" fontWeight="700" x="175" y="130">
          1 of 92,300 purchases
        </text>
        <text fill="var(--text-3)" fontSize="6.5" x="175" y="141">
          avg basket $38 · no buyer attached
        </text>
      </g>
    </g>
  );
}
