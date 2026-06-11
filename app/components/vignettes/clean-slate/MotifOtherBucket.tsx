/**
 * OTHER DATA · capture motif — the catch-all bucket. App A collects
 * "something" — the rows are deliberately shapeless (redaction bars with
 * unknown-shape glyphs) because the label genuinely doesn't say what.
 * Everything funnels into a dashed "OTHER" chip: the only name Apple
 * requires. Opacity itself is the story.
 *
 * Shared by the track + linked tiers; the not-linked tier renders its
 * own full scene. Animations: `.v-csm-row-*` for the rows, `.v-csm-pop`
 * for the chip.
 */
export default function MotifOtherBucket() {
  return (
    <g className="v-csm">
      {/* App A card */}
      <rect
        fill="var(--surface)"
        height="140"
        rx="8"
        stroke="var(--border-strong)"
        width="126"
        x="10"
        y="22"
      />

      {/* Header: ? badge + App A */}
      <rect fill="var(--text-3)" height="15" rx="3" width="15" x="16" y="29" />
      <text
        fill="#ffffff"
        fontSize="10"
        fontWeight="800"
        textAnchor="middle"
        x="23.5"
        y="40"
      >
        ?
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
        y="56"
      >
        ALSO COLLECTED
      </text>

      {/* Unnamed somethings — shape + redaction bar + ? */}
      <g className="v-csm-row-1">
        <circle cx="21" cy="72" fill="var(--text-3)" fillOpacity="0.8" r="4" />
        <rect
          fill="var(--text-3)"
          fillOpacity="0.25"
          height="7"
          rx="3.5"
          width="66"
          x="32"
          y="68.5"
        />
        <text fill="var(--text-3)" fontSize="8" fontWeight="700" x="104" y="75">
          ?
        </text>
      </g>
      <g className="v-csm-row-2">
        <path
          d="M 17 96 L 25 96 L 21 88 Z"
          fill="var(--text-3)"
          fillOpacity="0.8"
        />
        <rect
          fill="var(--text-3)"
          fillOpacity="0.25"
          height="7"
          rx="3.5"
          width="54"
          x="32"
          y="88.5"
        />
        <text fill="var(--text-3)" fontSize="8" fontWeight="700" x="104" y="95">
          ?
        </text>
      </g>
      <g className="v-csm-row-3">
        <rect
          fill="var(--text-3)"
          fillOpacity="0.8"
          height="8"
          width="8"
          x="17"
          y="104"
        />
        <rect
          fill="var(--text-3)"
          fillOpacity="0.25"
          height="7"
          rx="3.5"
          width="60"
          x="32"
          y="104.5"
        />
        <text
          fill="var(--text-3)"
          fontSize="8"
          fontWeight="700"
          x="104"
          y="111"
        >
          ?
        </text>
      </g>

      <line stroke="var(--border)" x1="16" x2="130" y1="122" y2="122" />

      {/* The only name the label gives any of it */}
      <g className="v-csm-pop">
        <rect
          fill="none"
          height="16"
          rx="8"
          stroke="var(--text-3)"
          strokeDasharray="3 2.5"
          width="64"
          x="41"
          y="130"
        />
        <text
          fill="var(--text-2)"
          fontSize="7.5"
          fontWeight="800"
          letterSpacing="1"
          textAnchor="middle"
          x="73"
          y="141"
        >
          OTHER
        </text>
      </g>
      <text
        fill="var(--text-3)"
        fontSize="5.5"
        textAnchor="middle"
        x="73"
        y="156"
      >
        that's all the label says
      </text>
    </g>
  );
}
