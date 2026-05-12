'use client';

import { useEffect } from 'react';

export const ADMIN_TOKEN_SESSION_KEY = 'pt:admin-token';
export const ADMIN_TOKEN_CHANGED_EVENT = 'pt:admin-token-changed';

function readAdminToken(): string {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_SESSION_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

function isSameOriginApiRequest(input: RequestInfo | URL): boolean {
  try {
    const raw =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
    const url = new URL(raw, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * Installs a tiny same-origin fetch shim that attaches the session-scoped
 * admin token to same-origin `/api/*` calls. This keeps LAN installs
 * ergonomic: users can unlock once in Settings, then reads and writes that
 * are guarded server-side work without every component manually plumbing a
 * token.
 */
export default function AdminTokenBridge() {
  useEffect(() => {
    const originalFetch = window.fetch.bind(window);
    const patchedFetch: typeof window.fetch = (input, init) => {
      const token = readAdminToken();
      if (token && isSameOriginApiRequest(input)) {
        const requestHeaders = input instanceof Request ? input.headers : undefined;
        const headers = new Headers(init?.headers ?? requestHeaders);
        headers.set('x-auditor-admin-token', token);
        return originalFetch(input, { ...init, headers });
      }
      return originalFetch(input, init);
    };

    window.fetch = patchedFetch;
    return () => {
      if (window.fetch === patchedFetch) {
        window.fetch = originalFetch;
      }
    };
  }, []);

  return null;
}
