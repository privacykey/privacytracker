'use client';

import { useMemo, useState } from 'react';

interface FaviconProps {
  /** Any URL — we extract the host and proxy the favicon through /api/favicon. */
  url: string | null | undefined;
  /** Rendered width/height in px. Matches `size` hint to the backend (currently unused server-side but reserved). */
  size?: number;
  /** Optional extra class so callers can tweak margin/inline alignment. */
  className?: string;
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
export default function Favicon({ url, size = 16, className = '' }: FaviconProps) {
  const host = useMemo(() => {
    if (!url) return null;
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
        className={`favicon-fallback ${className}`.trim()}
        style={{ width: size, height: size }}
        aria-hidden="true"
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
      src={`/api/favicon?host=${encodeURIComponent(host)}`}
      alt=""
      width={size}
      height={size}
      className={`favicon-img ${className}`.trim()}
      onError={() => setFailed(true)}
      aria-hidden="true"
      loading="lazy"
      decoding="async"
    />
  );
}
