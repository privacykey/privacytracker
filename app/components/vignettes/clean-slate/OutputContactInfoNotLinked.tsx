/**
 * CONTACT INFO · not-linked tier — the address itself is struck at
 * source; what survives is a sign-up tally (which email domains, which
 * countries) that no longer points at anyone. Your sign-up becomes one
 * bar in a domain breakdown.
 */
export default function OutputContactInfoNotLinked() {
  const bars = [
    { label: "@gmail.com", w: 126, c: "62%" },
    { label: "@outlook.com", w: 56, c: "21%" },
    { label: "other", w: 40, c: "17%" },
  ];
  return (
    <g className="v-cs v-cs-contactinfo-nl">
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

      {/* Raw sign-up log — the address is struck before anything moves */}
      <rect fill="#0f172a" height="108" rx="9" width="140" x="8" y="40" />
      <text fill="#94a3b8" fontSize="7" fontWeight="700" x="18" y="56">
        signup.log
      </text>
      <line stroke="#334155" x1="18" x2="138" y1="61" y2="61" />
      <g className="v-cs-redact">
        <text
          fill="#e2e8f0"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="6.5"
          x="18"
          y="78"
        >
          sam@mail.com
        </text>
      </g>
      <line
        className="v-cs-strike"
        stroke="var(--red, #dc2626)"
        strokeWidth="1.4"
        x1="16"
        x2="100"
        y1="75"
        y2="75"
      />
      <text
        fill="#e2e8f0"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        x="18"
        y="97"
      >
        domain=mail.com
      </text>
      <text
        fill="#64748b"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        x="18"
        y="115"
      >
        country=AU
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

      {/* Anonymous sign-up tally — domains, never addresses */}
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
          Sign-ups by domain
        </text>
        <line stroke="var(--border)" x1="175" x2="303" y1="61" y2="61" />
        {bars.map((b, i) => (
          <g key={b.label}>
            <rect
              fill="var(--blue, #2563eb)"
              fillOpacity="0.5"
              height="11"
              rx="2"
              width={b.w}
              x="175"
              y={70 + i * 16}
            />
            <text fill="var(--text)" fontSize="6.5" x="179" y={78 + i * 16}>
              {b.label}
            </text>
            <text
              fill="var(--text-2)"
              fontSize="6"
              textAnchor="end"
              x="303"
              y={78 + i * 16}
            >
              {b.c}
            </text>
          </g>
        ))}
        <text fill="var(--text-3)" fontSize="6.5" x="175" y="134">
          counts only · no addresses kept
        </text>
      </g>
    </g>
  );
}
