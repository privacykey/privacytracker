"use client";

import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A QR code drawn as one SVG path from uqr's module matrix: no canvas, no
 * data: URL, nothing a CSP has to allow. Dark modules on a white plate in
 * both themes, because a phone camera reads a light quiet zone around dark
 * modules far more reliably than the inverse.
 */
export default function CompanionQrCode({
  value,
  label,
  size = 232,
}: {
  value: string;
  /** Accessible name: the code carries a secret, so it says what it is for, not what it says. */
  label: string;
  size?: number;
}) {
  const { path, modules } = useMemo(() => {
    const { data, size: count } = encode(value, { ecc: "M", border: 2 });
    let d = "";
    for (let y = 0; y < count; y++) {
      const row = data[y];
      for (let x = 0; x < count; x++) {
        if (row[x]) {
          d += `M${x} ${y}h1v1h-1z`;
        }
      }
    }
    return { path: d, modules: count };
  }, [value]);

  return (
    <svg
      aria-label={label}
      className="companion-qr"
      height={size}
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
    >
      <rect fill="#ffffff" height={modules} width={modules} />
      <path d={path} fill="#111118" />
    </svg>
  );
}
