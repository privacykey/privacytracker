/**
 * CONTACTS · not-linked tier — every entry is stripped on device and
 * only a count leaves. That count is summed into a global total; no
 * names or numbers are ever pooled.
 */
export default function NotLinkedContacts() {
  return (
    <g className="v-cs v-cs-nl-contacts">
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
        Address book
      </text>
      <line stroke="var(--border)" x1="18" x2="138" y1="61" y2="61" />
      {[
        { y: 76, name: "Mum · +61 4·· 218", w: 96 },
        { y: 94, name: "Dr. Lee · +61 4·· 907", w: 104 },
        { y: 112, name: "Sarah M. · sarah@…", w: 100 },
      ].map((r) => (
        <g key={r.y}>
          <g className="v-cs-redact">
            <text fill="var(--text)" fontSize="7" x="18" y={r.y}>
              {r.name}
            </text>
          </g>
          <line
            className="v-cs-strike"
            stroke="var(--red, #dc2626)"
            strokeWidth="1.4"
            x1="16"
            x2={16 + r.w}
            y1={r.y - 3}
            y2={r.y - 3}
          />
        </g>
      ))}
      <text fill="var(--text-3)" fontSize="6.5" x="18" y="130">
        + 309 more
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
        <text
          fill="var(--text-3)"
          fontSize="7"
          textAnchor="middle"
          x="239"
          y="57"
        >
          Only a number leaves
        </text>
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="26"
          fontWeight="800"
          textAnchor="middle"
          x="239"
          y="88"
        >
          312
        </text>
        {/* summed into a global total */}
        <text
          fill="var(--text-3)"
          fontSize="7"
          textAnchor="middle"
          x="239"
          y="104"
        >
          + 1.2M users
        </text>
        <text
          fill="var(--text-2)"
          fontSize="8"
          fontWeight="700"
          textAnchor="middle"
          x="239"
          y="120"
        >
          → 290M contacts counted
        </text>
        <text
          fill="var(--text-3)"
          fontSize="6.5"
          textAnchor="middle"
          x="239"
          y="134"
        >
          0 names · 0 numbers stored
        </text>
      </g>
    </g>
  );
}
