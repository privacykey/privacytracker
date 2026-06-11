/**
 * USER CONTENT · capture motif — a photo library / camera roll. A header
 * with the count, then a 3×3 grid of thumbnails (one a selfie) cascading
 * in row by row. Bespoke to the clean-slate set.
 */
const TILES = [
  [{ fill: "#bfe3ff" }, { fill: "#e5e7eb", face: true }, { fill: "#fde2c4" }],
  [{ fill: "#c7e9d0" }, { fill: "#dbeafe" }, { fill: "#fde68a" }],
  [{ fill: "#e9d5ff" }, { fill: "#fbcfe8" }, { fill: "#c7d2fe" }],
];

export default function MotifPhotoLibrary() {
  const xs = [18, 54, 90];
  const ys = [52, 82, 112];
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
      <text fill="var(--text-2)" fontSize="8" fontWeight="700" x="18" y="40">
        Photos
      </text>
      <text fill="var(--text-3)" fontSize="6.5" textAnchor="end" x="128" y="40">
        2,318
      </text>
      <line stroke="var(--border)" x1="16" x2="130" y1="46" y2="46" />

      {TILES.map((row, r) => (
        <g className={`v-csm-row-${r + 1}`} key={`row-${r}`}>
          {row.map((t, c) => (
            <g key={`t-${r}-${c}`}>
              <rect
                fill={t.fill}
                height="26"
                rx="3"
                width="32"
                x={xs[c]}
                y={ys[r]}
              />
              {t.face ? (
                <>
                  <circle
                    cx={xs[c] + 16}
                    cy={ys[r] + 11}
                    fill="#9ca3af"
                    r="4"
                  />
                  <path
                    d={`M ${xs[c] + 9} ${ys[r] + 24} Q ${xs[c] + 16} ${ys[r] + 16} ${xs[c] + 23} ${ys[r] + 24}`}
                    fill="#9ca3af"
                  />
                </>
              ) : null}
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}
