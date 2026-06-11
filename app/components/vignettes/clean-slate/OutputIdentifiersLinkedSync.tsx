import CleanSlatePulses from "./CleanSlatePulses";

/**
 * IDENTIFIERS · linked tier — the milder use: the ID ties your sessions
 * to your own account so you stay signed in and synced across your
 * devices. One company, your account — not brokered across the web.
 */
export default function OutputIdentifiersLinkedSync() {
  return (
    <g className="v-cs v-cs-linked-ident">
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
        WHAT THE APP DOES
      </text>

      <g className="v-cs-surface">
        <rect
          fill="var(--bg-2, #fff)"
          height="114"
          rx="10"
          stroke="var(--border-strong)"
          width="152"
          x="156"
          y="36"
        />
        <text fill="var(--text)" fontSize="8" fontWeight="700" x="164" y="53">
          Synced to your account
        </text>
        <line stroke="var(--border)" x1="164" x2="300" y1="60" y2="60" />
      </g>

      {/* Two of your devices, one account */}
      <g className="v-cs-row v-cs-row-1">
        {/* phone */}
        <rect
          fill="var(--surface)"
          height="34"
          rx="4"
          stroke="var(--border-strong)"
          width="22"
          x="186"
          y="72"
        />
        <text fontSize="11" x="191" y="93">
          📱
        </text>
        <text
          fill="var(--text-3)"
          fontSize="6"
          textAnchor="middle"
          x="197"
          y="116"
        >
          iPhone
        </text>
        {/* tablet */}
        <rect
          fill="var(--surface)"
          height="30"
          rx="4"
          stroke="var(--border-strong)"
          width="30"
          x="252"
          y="74"
        />
        <text fontSize="12" x="259" y="95">
          💻
        </text>
        <text
          fill="var(--text-3)"
          fontSize="6"
          textAnchor="middle"
          x="267"
          y="116"
        >
          iPad
        </text>
      </g>

      {/* sync link between them */}
      <g className="v-cs-row v-cs-row-2">
        <line
          stroke="var(--green, #16a34a)"
          strokeDasharray="3 2"
          strokeWidth="1.4"
          x1="210"
          x2="250"
          y1="88"
          y2="88"
        />
        <text
          fill="var(--green, #16a34a)"
          fontSize="9"
          textAnchor="middle"
          x="230"
          y="85"
        >
          ⇄
        </text>
      </g>

      <text
        className="v-cs-fade"
        fill="var(--orange, #ea580c)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="134"
      >
        Keeps you signed in across devices
      </text>
    </g>
  );
}
