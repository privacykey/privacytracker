import CleanSlatePulses from "./CleanSlatePulses";

/**
 * CONTACTS · linked tier — the milder use: the app matches your contacts
 * only to people who *already* use App A and suggests adding them. No
 * shadow profiles on non-users, nothing sold.
 */
export default function OutputContactsLinkedFriends() {
  const friends = [
    { y: 80, fill: "#fbbf24", name: "Mum" },
    { y: 100, fill: "#a78bfa", name: "Priya" },
    { y: 120, fill: "#34d399", name: "Tom" },
  ];
  return (
    <g className="v-cs v-cs-linked-contacts">
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
          height="116"
          rx="10"
          stroke="var(--border-strong)"
          width="152"
          x="156"
          y="36"
        />
        <text fill="var(--text)" fontSize="8" fontWeight="700" x="164" y="53">
          People you may know
        </text>
        <line stroke="var(--border)" x1="164" x2="300" y1="60" y2="60" />
        <text fill="var(--text-3)" fontSize="6" x="164" y="71">
          friends already on App A
        </text>
      </g>

      {friends.map((f, i) => (
        <g className={`v-cs-row v-cs-row-${i + 1}`} key={f.name}>
          <circle cx="171" cy={f.y - 3} fill={f.fill} r="5" />
          <text fill="var(--text)" fontSize="7.5" x="182" y={f.y}>
            {f.name}
          </text>
          <rect
            fill="var(--blue, #2563eb)"
            height="12"
            rx="6"
            width="34"
            x="262"
            y={f.y - 9}
          />
          <text
            fill="#ffffff"
            fontSize="6.5"
            fontWeight="700"
            textAnchor="middle"
            x="279"
            y={f.y - 1}
          >
            Add
          </text>
        </g>
      ))}

      <text
        className="v-cs-fade"
        fill="var(--orange, #ea580c)"
        fontSize="6.5"
        fontWeight="600"
        x="164"
        y="136"
      >
        Matched only to existing App A users
      </text>
    </g>
  );
}
