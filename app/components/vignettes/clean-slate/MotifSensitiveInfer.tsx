/**
 * SENSITIVE INFO · capture motif — beliefs are *inferred*, not asked for.
 * App A watches neutral behaviour (what you read, the groups you join, the
 * pages you like), runs a scan over it, and pops out sensitive-category
 * guesses (faith, political leaning). The point: you never typed these in.
 *
 * Clean-slate-specific. Shared by the track + linked tiers; the not-linked
 * tier renders its own full scene. Animations live in clean-slate.css
 * (`.v-csm`, `.v-csm-row-*`, `.v-csm-scan`, `.v-csm-pop`).
 */
export default function MotifSensitiveInfer() {
  const signals = [
    { icon: "📰", label: "Articles you read", y: 74 },
    { icon: "👥", label: "Groups you joined", y: 90 },
    { icon: "❤️", label: "Pages you liked", y: 106 },
  ];

  return (
    <g className="v-csm">
      {/* App A observation card */}
      <rect
        fill="var(--surface)"
        height="140"
        rx="8"
        stroke="var(--border-strong)"
        width="126"
        x="10"
        y="22"
      />

      {/* Header: inference badge + App A */}
      <rect fill="#9333ea" height="15" rx="3" width="15" x="16" y="29" />
      <text fontSize="9" textAnchor="middle" x="23.5" y="40">
        🔎
      </text>
      <text fill="var(--text-2)" fontSize="8" fontWeight="700" x="35" y="40">
        App A
      </text>

      <text
        fill="var(--text-3)"
        fontSize="6"
        fontWeight="700"
        letterSpacing="0.4"
        x="16"
        y="58"
      >
        WHAT YOU DID
      </text>

      {/* Neutral behaviour signals cascade in */}
      {signals.map((s, i) => (
        <g className={`v-csm-row-${i + 1}`} key={s.label}>
          <text fontSize="8.5" x="17" y={s.y}>
            {s.icon}
          </text>
          <text fill="var(--text)" fontSize="7.5" x="32" y={s.y - 1}>
            {s.label}
          </text>
        </g>
      ))}

      {/* Scan sweep over the behaviour */}
      <rect
        className="v-csm-scan"
        fill="#9333ea"
        fillOpacity="0.14"
        height="48"
        width="118"
        x="14"
        y="66"
      />

      <line stroke="var(--border)" x1="16" x2="130" y1="116" y2="116" />

      <text
        fill="#9333ea"
        fontSize="6"
        fontWeight="700"
        letterSpacing="0.4"
        x="16"
        y="128"
      >
        INFERRED ABOUT YOU
      </text>

      {/* Sensitive-category guesses pop out */}
      <g className="v-csm-pop">
        <rect
          fill="rgba(147,51,234,0.16)"
          height="14"
          rx="7"
          stroke="#9333ea"
          width="50"
          x="16"
          y="134"
        />
        <text
          fill="#9333ea"
          fontSize="7"
          fontWeight="700"
          textAnchor="middle"
          x="41"
          y="144"
        >
          Faith
        </text>
        <rect
          fill="rgba(147,51,234,0.16)"
          height="14"
          rx="7"
          stroke="#9333ea"
          width="62"
          x="70"
          y="134"
        />
        <text
          fill="#9333ea"
          fontSize="7"
          fontWeight="700"
          textAnchor="middle"
          x="101"
          y="144"
        >
          Leaning
        </text>
      </g>
    </g>
  );
}
