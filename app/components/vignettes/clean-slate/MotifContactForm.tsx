/**
 * CONTACT INFO · capture motif — the most familiar capture there is: a
 * sign-up form. App A asks for your name, email and phone; the email
 * types itself in (reusing the financial motif's typed-clip animation).
 * This is the LEFT (capture) half shared by the track + linked tiers;
 * the not-linked tier renders its own full scene.
 *
 * Animations live in clean-slate.css (`.v-csm`, `.v-csm-row-*`,
 * `.v-csm-salary` for the typed field).
 */
export default function MotifContactForm() {
  return (
    <g className="v-csm">
      {/* App A sign-up card */}
      <rect
        fill="var(--surface)"
        height="140"
        rx="8"
        stroke="var(--border-strong)"
        width="126"
        x="10"
        y="22"
      />

      {/* Header: person badge + App A */}
      <rect
        fill="var(--blue, #2563eb)"
        height="15"
        rx="3"
        width="15"
        x="16"
        y="29"
      />
      <text fontSize="9" textAnchor="middle" x="23.5" y="40">
        👤
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
        CREATE ACCOUNT
      </text>

      {/* Name field */}
      <g className="v-csm-row-1">
        <text
          fill="var(--text-3)"
          fontSize="5.5"
          fontWeight="700"
          x="16"
          y="68"
        >
          NAME
        </text>
        <rect
          fill="var(--bg-2, #fff)"
          height="15"
          rx="3"
          stroke="var(--border-strong)"
          width="110"
          x="16"
          y="71"
        />
        <text fill="var(--text)" fontSize="7.5" x="21" y="81">
          Sam Taylor
        </text>
      </g>

      {/* Email field — types in */}
      <g className="v-csm-row-2">
        <text
          fill="var(--text-3)"
          fontSize="5.5"
          fontWeight="700"
          x="16"
          y="98"
        >
          EMAIL
        </text>
        <rect
          fill="var(--bg-2, #fff)"
          height="15"
          rx="3"
          stroke="var(--border-strong)"
          width="110"
          x="16"
          y="101"
        />
      </g>
      <g className="v-csm-salary">
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="7"
          x="21"
          y="111"
        >
          sam@mail.com
        </text>
      </g>

      {/* Phone field */}
      <g className="v-csm-row-3">
        <text
          fill="var(--text-3)"
          fontSize="5.5"
          fontWeight="700"
          x="16"
          y="128"
        >
          PHONE
        </text>
        <rect
          fill="var(--bg-2, #fff)"
          height="15"
          rx="3"
          stroke="var(--border-strong)"
          width="110"
          x="16"
          y="131"
        />
        <text fill="var(--text)" fontSize="7.5" x="21" y="141">
          0412 555 014
        </text>
      </g>
    </g>
  );
}
