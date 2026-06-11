/**
 * LOCATION · not-linked tier — identifiers stripped at source, then the
 * coarsened ping is pooled with tens of thousands of others in the same
 * area. Your dot is indistinguishable in the cloud — no name, no device.
 */
export default function NotLinkedLocation() {
  // Deterministic scatter of anonymous pings inside the area tile.
  const pings = Array.from({ length: 34 }, (_, i) => ({
    cx: 178 + ((i * 41) % 122),
    cy: 70 + ((i * 67) % 40),
  }));

  return (
    <g className="v-cs v-cs-nl-location">
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

      {/* Raw ping (left) */}
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
        Location ping
      </text>
      <line stroke="var(--border)" x1="18" x2="138" y1="61" y2="61" />
      <g className="v-cs-redact">
        <text fill="var(--text)" fontSize="7.5" x="18" y="76">
          Name: You
        </text>
      </g>
      <line
        className="v-cs-strike"
        stroke="var(--red, #dc2626)"
        strokeWidth="1.4"
        x1="16"
        x2="74"
        y1="73"
        y2="73"
      />
      <g className="v-cs-redact">
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="6.5"
          x="18"
          y="93"
        >
          Device A1B2-C3D4
        </text>
      </g>
      <line
        className="v-cs-strike"
        stroke="var(--red, #dc2626)"
        strokeWidth="1.4"
        x1="16"
        x2="108"
        y1="90"
        y2="90"
      />
      <text
        fill="var(--text-2)"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        x="18"
        y="110"
      >
        −33.8601, 151.2002
      </text>
      <text
        fill="var(--text-2)"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        x="18"
        y="127"
      >
        08:15:22
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

      {/* Pooled into the crowd (right) */}
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
          Pooled by area
        </text>
        <line stroke="var(--border)" x1="175" x2="303" y1="61" y2="61" />
        <rect fill="#e0f2fe" height="50" rx="6" width="130" x="174" y="66" />
        {pings.map((d) => (
          <circle
            cx={d.cx}
            cy={d.cy}
            fill="#0369a1"
            fillOpacity="0.55"
            key={`${d.cx}-${d.cy}`}
            r="1.6"
          />
        ))}
        <text fill="var(--text)" fontSize="8" fontWeight="700" x="175" y="130">
          1 of 48,210 pings here
        </text>
        <text fill="var(--text-3)" fontSize="6.5" x="175" y="141">
          today · no names, no device IDs
        </text>
      </g>
    </g>
  );
}
