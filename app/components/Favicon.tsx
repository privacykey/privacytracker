"use client";

import { useMemo, useState } from "react";

interface FaviconProps {
  /** Optional extra class so callers can tweak margin/inline alignment. */
  className?: string;
  /** Rendered width/height in px. Matches `size` hint to the backend (currently unused server-side but reserved). */
  size?: number;
  /** Any URL — we extract the host and proxy the favicon through /api/favicon. */
  url: string | null | undefined;
}

/**
 * Inline favicon rendered from `/api/favicon?host=...`. Purely decorative —
 * the `alt` is empty and the element is aria-hidden so screen readers skip
 * it. The parent link already carries the accessible label.
 *
 * Behaviour:
 *   - No URL / unparseable host → renders a neutral globe placeholder so
 *     the row layout stays stable.
 *   - 404 / network error from our proxy → same placeholder (onError).
 *   - Otherwise renders the upstream icon scaled to `size`.
 *
 * We proxy through our own origin (lib/api/favicon) to keep the user's
 * browser from pinging third-party hosts just because a Manual Apps page
 * is open — this is a privacy auditor, after all.
 */
export default function Favicon({
  url,
  size = 16,
  className = "",
}: FaviconProps) {
  const host = useMemo(() => {
    if (!url) {
      return null;
    }
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }, [url]);

  const [failed, setFailed] = useState(false);

  if (!host || failed) {
    return (
      <span
        aria-hidden="true"
        className={`favicon-fallback ${className}`.trim()}
        style={{ width: size, height: size }}
      >
        🌐
      </span>
    );
  }

  return (
    // Using <img> (not next/image) deliberately — the proxy response is
    // already tiny and cacheable, and next/image would require remote-host
    // allowlisting for every domain the user tracks.
    <img
      alt=""
      aria-hidden="true"
      className={`favicon-img ${className}`.trim()}
      decoding="async"
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      src={`/api/favicon?host=${encodeURIComponent(host)}`}
      width={size}
    />
  );
}
