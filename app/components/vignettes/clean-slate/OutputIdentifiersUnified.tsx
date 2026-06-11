import CleanSlatePulses from "./CleanSlatePulses";

/**
 * IDENTIFIERS · output — "One ID links every app".
 *
 * Three unrelated apps (Maps, Shop, Dating) each carry the *same*
 * advertising ID chip — that repetition is the point. Converging lines
 * then stitch all three down into a single profile, so the shared
 * identifier is literally the thread that ties separate apps to one
 * person.
 */
export default function OutputIdentifiersUnified() {
  const tiles = [
    { x: 166, label: "Maps", fill: "var(--blue, #2563eb)", row: "v-cs-row-1" },
    {
      x: 220,
      label: "Shop",
      fill: "var(--orange, #ea580c)",
      row: "v-cs-row-2",
    },
    {
      x: 274,
      label: "Dating",
      fill: "var(--green, #16a34a)",
      row: "v-cs-row-3",
    },
  ];

  return (
    <g className="v-cs v-cs-identifiers">
      <CleanSlatePulses y={70} />

      <text
        className="v-cs-fade"
        fill="var(--text-3)"
        fontSize="6.5"
        fontWeight="700"
        letterSpacing="0.6"
        x="160"
        y="28"
      >
        WHAT THEY DO WITH IT
      </text>

      {/* Three apps, each stamped with the identical ad ID. */}
      {tiles.map((t) => {
        const cx = t.x + 11;
        return (
          <g className={`v-cs-row ${t.row}`} key={t.label}>
            <rect fill={t.fill} height="22" rx="5" width="22" x={t.x} y="40" />
            <text
              fill="var(--text-2)"
              fontSize="6"
              textAnchor="middle"
              x={cx}
              y="71"
            >
              {t.label}
            </text>
            <rect
              fill="var(--blue-soft, #dbeafe)"
              height="11"
              rx="5.5"
              width="36"
              x={cx - 18}
              y="76"
            />
            <text
              fill="var(--blue, #2563eb)"
              fontFamily="ui-monospace, 'SF Mono', monospace"
              fontSize="5"
              fontWeight="700"
              textAnchor="middle"
              x={cx}
              y="83.5"
            >
              A1B2-C3D4
            </text>
          </g>
        );
      })}

      {/* Converging links — drawn last (the stitch). */}
      <g
        fill="none"
        stroke="var(--blue, #2563eb)"
        strokeLinecap="round"
        strokeWidth="1.3"
      >
        <line className="v-cs-link" x1="177" x2="231" y1="88" y2="118" />
        <line className="v-cs-link" x1="231" x2="231" y1="88" y2="118" />
        <line className="v-cs-link" x1="285" x2="231" y1="88" y2="118" />
      </g>

      {/* The merged identity all three resolve to. */}
      <g className="v-cs-fade">
        <rect
          fill="var(--bg-2, #fff)"
          height="34"
          rx="8"
          stroke="var(--border-strong)"
          width="116"
          x="174"
          y="120"
        />
        <text fontSize="13" x="182" y="142">
          👤
        </text>
        <text fill="var(--text)" fontSize="8" fontWeight="700" x="200" y="135">
          One profile — you
        </text>
        <text
          fill="var(--text-3)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="6"
          x="200"
          y="146"
        >
          tied by A1B2-C3D4
        </text>
      </g>
    </g>
  );
}
