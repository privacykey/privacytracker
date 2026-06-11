/**
 * Map grid with three breadcrumb pins lighting up in sequence and a
 * main pin dropping onto the final position.
 */
export default function MotifLocation() {
  return (
    <g className="v-motif-location">
      {/* Map background */}
      <rect fill="#e0f2fe" height="138" rx="6" width="126" x="10" y="22" />
      {/* Roads */}
      <line stroke="#bae6fd" strokeWidth="7" x1="10" x2="136" y1="56" y2="56" />
      <line
        stroke="#bae6fd"
        strokeWidth="7"
        x1="10"
        x2="136"
        y1="100"
        y2="100"
      />
      <line stroke="#bae6fd" strokeWidth="7" x1="44" x2="44" y1="22" y2="160" />
      <line
        stroke="#bae6fd"
        strokeWidth="7"
        x1="100"
        x2="100"
        y1="22"
        y2="160"
      />
      {/* Breadcrumbs */}
      <circle
        className="v-crumb v-crumb-1"
        cx="30"
        cy="78"
        fill="var(--red, #dc2626)"
        r="4"
      />
      <circle
        className="v-crumb v-crumb-2"
        cx="70"
        cy="78"
        fill="var(--red, #dc2626)"
        r="4"
      />
      <circle
        className="v-crumb v-crumb-3"
        cx="110"
        cy="78"
        fill="var(--red, #dc2626)"
        r="4"
      />
      <line
        className="v-trail"
        stroke="var(--red, #dc2626)"
        strokeDasharray="3 3"
        strokeWidth="1.5"
        x1="30"
        x2="110"
        y1="78"
        y2="78"
      />
      {/* Main pin drops */}
      <g
        className="v-pin"
        style={{ transformOrigin: "118px 116px", transformBox: "fill-box" }}
      >
        <text fontSize="28" x="106" y="124">
          📍
        </text>
      </g>
    </g>
  );
}
