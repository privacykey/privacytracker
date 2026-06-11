import CleanSlatePulses from "./CleanSlatePulses";

/**
 * CONTACT INFO · linked tier — the calm use. Your name, email and phone
 * are tied to you because they run your account: sign-in, receipts,
 * delivery updates. Kept inside App A, not passed along.
 */
export default function OutputContactInfoAccount() {
  return (
    <g className="v-cs v-cs-contactinfo-linked">
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
          height="112"
          rx="10"
          stroke="var(--border-strong)"
          width="152"
          x="156"
          y="36"
        />
        <text fill="var(--text-2)" fontSize="8" fontWeight="700" x="164" y="53">
          Your account
        </text>
        <rect
          fill="none"
          height="13"
          rx="6.5"
          stroke="var(--orange, #ea580c)"
          strokeWidth="1.2"
          width="46"
          x="252"
          y="44"
        />
        <text
          fill="var(--orange, #ea580c)"
          fontSize="6.5"
          fontWeight="800"
          textAnchor="middle"
          x="275"
          y="53"
        >
          LINKED
        </text>
        <line stroke="var(--border)" x1="164" x2="300" y1="60" y2="60" />
      </g>

      {/* Who you are, on file */}
      <g className="v-cs-row v-cs-row-1">
        <circle cx="171" cy="73" fill="var(--blue, #2563eb)" r="6.5" />
        <text
          fill="#ffffff"
          fontSize="7"
          fontWeight="700"
          textAnchor="middle"
          x="171"
          y="76"
        >
          S
        </text>
        <text fill="var(--text)" fontSize="7.5" fontWeight="700" x="182" y="71">
          Sam Taylor
        </text>
        <text fill="var(--text-3)" fontSize="6.5" x="182" y="80">
          sam@mail.com
        </text>
      </g>

      {/* What it's actually for */}
      <g className="v-cs-row v-cs-row-2">
        <text fontSize="8" x="164" y="98">
          🔑
        </text>
        <text fill="var(--text)" fontSize="7" x="177" y="97">
          Signs you in
        </text>
      </g>
      <g className="v-cs-row v-cs-row-3">
        <text fontSize="8" x="164" y="112">
          🧾
        </text>
        <text fill="var(--text)" fontSize="7" x="177" y="111">
          Sends your receipts
        </text>
      </g>
      <g className="v-cs-row v-cs-row-4">
        <text fontSize="8" x="164" y="126">
          📦
        </text>
        <text fill="var(--text)" fontSize="7" x="177" y="125">
          Delivery updates
        </text>
      </g>

      <text
        className="v-cs-fade"
        fill="var(--orange, #ea580c)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="140"
      >
        Stays in App A · not sold
      </text>
    </g>
  );
}
