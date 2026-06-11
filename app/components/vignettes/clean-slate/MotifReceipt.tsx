/**
 * PURCHASES · capture motif — a printed receipt. A store header, three
 * itemised lines that print in one by one, a total, and a torn bottom
 * edge. The basket quietly signals a life event (a new puppy). Bespoke
 * to the clean-slate set.
 */
export default function MotifReceipt() {
  // Torn bottom edge — alternating teeth across the slip width.
  const teeth: string[] = ["M 24 150"];
  for (let i = 0; i < 7; i++) {
    const x = 24 + i * 13.4;
    teeth.push(`L ${x + 6.7} 156 L ${x + 13.4} 150`);
  }
  const tornPath = `${teeth.join(" ")} L 118 150 Z`;

  const items = [
    { name: "Dog bowl", price: "$14" },
    { name: "Puppy food", price: "$28" },
    { name: "Chew toy", price: "$9" },
  ];
  const ys = [58, 76, 94];

  return (
    <g className="v-csm">
      <rect
        fill="#ffffff"
        height="128"
        rx="2"
        stroke="#cbd5e1"
        width="94"
        x="24"
        y="22"
      />
      <path d={tornPath} fill="#ffffff" stroke="#cbd5e1" />

      <text
        fill="#475569"
        fontSize="6.5"
        fontWeight="700"
        letterSpacing="0.5"
        textAnchor="middle"
        x="71"
        y="37"
      >
        APP A · STORE
      </text>
      <line
        stroke="#e5e7eb"
        strokeDasharray="2 2"
        x1="30"
        x2="112"
        y1="43"
        y2="43"
      />

      {items.map((it, i) => (
        <g className={`v-csm-row-${i + 1}`} key={it.name}>
          <text fill="#1c1c1e" fontSize="6.5" x="30" y={ys[i]}>
            {it.name}
          </text>
          <text
            fill="#475569"
            fontFamily="ui-monospace, 'SF Mono', monospace"
            fontSize="6.5"
            textAnchor="end"
            x="112"
            y={ys[i]}
          >
            {it.price}
          </text>
        </g>
      ))}

      <line stroke="#cbd5e1" x1="30" x2="112" y1="104" y2="104" />
      <text fill="#1c1c1e" fontSize="7" fontWeight="700" x="30" y="118">
        TOTAL
      </text>
      <text
        fill="#1c1c1e"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="7"
        fontWeight="700"
        textAnchor="end"
        x="112"
        y="118"
      >
        $51
      </text>
    </g>
  );
}
