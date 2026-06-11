/**
 * Clean-slate IDENTIFIERS capture motif — a device fingerprint being
 * read. Concentric ridge arcs form a fingerprint, a scan line sweeps
 * down it once, and the resulting advertising ID + device signals pop
 * in below. Bespoke to the clean-slate set (does not reuse the shared
 * silhouette/barcode motif).
 */
export default function MotifIdentifiersFingerprint() {
  return (
    <g className="v-csm">
      <rect
        fill="var(--surface)"
        height="146"
        rx="8"
        stroke="var(--border-strong)"
        width="126"
        x="10"
        y="22"
      />

      {/* Header */}
      <rect fill="#0d9488" height="15" rx="3" width="15" x="16" y="29" />
      <rect fill="#ffffff" height="1.4" rx="0.7" width="9" x="19" y="34" />
      <rect fill="#ffffff" height="1.4" rx="0.7" width="7" x="19" y="37" />
      <rect fill="#ffffff" height="1.4" rx="0.7" width="9" x="19" y="40" />
      <text fill="var(--text-2)" fontSize="8" fontWeight="700" x="35" y="40">
        App A
      </text>

      {/* Fingerprint ridges */}
      <g
        fill="none"
        stroke="var(--text-2)"
        strokeLinecap="round"
        strokeWidth="1.2"
      >
        <path d="M62 86 Q72 76 82 86" />
        <path d="M57 88 Q72 68 87 88" />
        <path d="M52 90 Q72 60 92 90" />
        <path d="M47 92 Q72 53 97 92" />
        <path d="M43 94 Q72 47 101 94" />
      </g>

      {/* Scan line sweeping down the print */}
      <line
        className="v-csm-scan"
        stroke="#0d9488"
        strokeWidth="1.5"
        x1="44"
        x2="100"
        y1="54"
        y2="54"
      />

      {/* Captured identifier + device signals */}
      <text
        fill="var(--text-3)"
        fontSize="6"
        fontWeight="700"
        letterSpacing="0.4"
        x="16"
        y="122"
      >
        ADVERTISING ID
      </text>
      <g className="v-csm-pop">
        <text
          fill="var(--text)"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="9"
          fontWeight="700"
          x="16"
          y="136"
        >
          A1B2-C3D4-E5F6
        </text>
      </g>
      <text fill="var(--text-3)" fontSize="6.5" x="16" y="151">
        iPhone · iOS 18.2 · en-AU
      </text>
    </g>
  );
}
