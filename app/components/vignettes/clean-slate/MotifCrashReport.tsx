/**
 * DIAGNOSTICS · capture motif — the app falls over and a crash report
 * writes itself: a couple of stack-trace lines in a mini terminal, then
 * the device facts (model, OS, battery) that ride along with every
 * report. Those facts are the seed of the track tier's fingerprint
 * story. Shared by the track + linked tiers.
 */
export default function MotifCrashReport() {
  return (
    <g className="v-csm">
      {/* Crash-report sheet */}
      <rect
        fill="var(--surface)"
        height="140"
        rx="8"
        stroke="var(--border-strong)"
        width="126"
        x="10"
        y="22"
      />

      {/* Header: warning badge + App A */}
      <rect
        fill="var(--red, #dc2626)"
        height="15"
        rx="3"
        width="15"
        x="16"
        y="29"
      />
      <text fontSize="9" textAnchor="middle" x="23.5" y="40">
        ⚠️
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
        CRASH REPORT
      </text>

      {/* Mini terminal — the stack trace types in */}
      <rect fill="#0f172a" height="36" rx="5" width="110" x="16" y="61" />
      <g className="v-csm-salary">
        <text
          fill="#e2e8f0"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="6"
          x="22"
          y="74"
        >
          Thread 0 crashed
        </text>
      </g>
      <g className="v-csm-row-1">
        <text
          fill="#64748b"
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="6"
          x="22"
          y="88"
        >
          0x1f3a memcpy+0x44
        </text>
      </g>

      {/* The device facts that ride along */}
      <text
        fill="var(--text-3)"
        fontSize="6"
        fontWeight="700"
        letterSpacing="0.4"
        x="16"
        y="112"
      >
        SENT WITH IT
      </text>
      <g className="v-csm-row-2">
        <text fontSize="8" x="17" y="126">
          📱
        </text>
        <text fill="var(--text)" fontSize="7" x="31" y="125">
          iPhone 15 · iOS 18.2
        </text>
      </g>
      <g className="v-csm-row-3">
        <text fontSize="8" x="17" y="141">
          🔋
        </text>
        <text fill="var(--text)" fontSize="7" x="31" y="140">
          12% battery · 3 GB free
        </text>
      </g>
      <g className="v-csm-row-4">
        <text fontSize="8" x="17" y="156">
          🌐
        </text>
        <text fill="var(--text)" fontSize="7" x="31" y="155">
          Carrier · locale · uptime
        </text>
      </g>
    </g>
  );
}
