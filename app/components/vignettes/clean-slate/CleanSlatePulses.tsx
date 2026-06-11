/**
 * Three small data pulses that leave the motif (left) and cross the gap
 * into the output zone (right). Shared by every clean-slate output so
 * the "the data travels, then becomes a real thing" beat is consistent.
 *
 * Animated via `.v-cs-pulse-{1,2,3}` in clean-slate.css. The parent
 * `<g>` must carry the `v-cs` class for the descendant selectors to
 * apply.
 */
export default function CleanSlatePulses({ y = 92 }: { y?: number }) {
  return (
    <g>
      <circle
        className="v-cs-pulse v-cs-pulse-1"
        cx="140"
        cy={y - 7}
        fill="var(--red, #dc2626)"
        r="3"
      />
      <circle
        className="v-cs-pulse v-cs-pulse-2"
        cx="140"
        cy={y}
        fill="var(--red, #dc2626)"
        r="3"
      />
      <circle
        className="v-cs-pulse v-cs-pulse-3"
        cx="140"
        cy={y + 7}
        fill="var(--red, #dc2626)"
        r="3"
      />
    </g>
  );
}
