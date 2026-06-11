/**
 * Clean-slate CONTACTS capture motif — the iOS-style permission sheet,
 * now previewing the actual contacts you're about to hand over. Sarah
 * sits at the top of your address book (highlighted, same "S" avatar as
 * the dossier on the right) so it's obvious she's one of YOUR shared
 * contacts. Bespoke to the clean-slate set.
 */
export default function MotifContactsPermission() {
  return (
    <g className="v-csm">
      <rect
        fill="var(--surface)"
        height="140"
        rx="8"
        stroke="var(--border-strong)"
        width="126"
        x="10"
        y="22"
      />

      {/* Header */}
      <rect
        fill="var(--blue, #2563eb)"
        height="15"
        rx="3"
        width="15"
        x="16"
        y="29"
      />
      <circle cx="20.5" cy="35.5" fill="#ffffff" r="2" />
      <circle cx="27" cy="35.5" fill="#ffffff" r="2" />
      <text fill="var(--text-2)" fontSize="8" fontWeight="700" x="35" y="40">
        App A
      </text>

      {/* Permission sheet */}
      <g className="v-csm-pop">
        <rect
          fill="var(--bg-2, #fff)"
          height="112"
          rx="8"
          stroke="var(--border-strong)"
          width="110"
          x="18"
          y="46"
        />
        <text
          fill="var(--text)"
          fontSize="8"
          fontWeight="700"
          textAnchor="middle"
          x="73"
          y="59"
        >
          Share your Contacts?
        </text>

        {/* Preview of the address book being shared — Sarah first,
            highlighted, with the same avatar as the right-hand dossier. */}
        <rect
          fill="var(--blue-soft, #dbeafe)"
          height="13"
          rx="3"
          width="98"
          x="24"
          y="66"
        />
        <circle cx="32" cy="72.5" fill="var(--text-3)" r="4" />
        <text
          fill="#ffffff"
          fontSize="5.5"
          fontWeight="700"
          textAnchor="middle"
          x="32"
          y="74.5"
        >
          S
        </text>
        <text fill="var(--text)" fontSize="7" fontWeight="700" x="40" y="75">
          Sarah M.
        </text>

        <circle cx="32" cy="88" fill="#fbbf24" r="4" />
        <text fill="var(--text-2)" fontSize="7" x="40" y="90.5">
          Mum
        </text>

        <circle cx="32" cy="102" fill="#a78bfa" r="4" />
        <text fill="var(--text-2)" fontSize="7" x="40" y="104.5">
          Dr. Lee
        </text>

        <text
          fill="var(--text-3)"
          fontSize="6"
          textAnchor="middle"
          x="73"
          y="118"
        >
          + 309 more
        </text>

        {/* Allow button */}
        <rect
          fill="var(--blue, #2563eb)"
          height="15"
          rx="4"
          width="90"
          x="28"
          y="124"
        />
        <text
          fill="#ffffff"
          fontSize="8"
          fontWeight="700"
          textAnchor="middle"
          x="73"
          y="134"
        >
          Allow
        </text>
        <text
          fill="var(--text-3)"
          fontSize="7"
          textAnchor="middle"
          x="73"
          y="151"
        >
          Don't Allow
        </text>
      </g>
    </g>
  );
}
