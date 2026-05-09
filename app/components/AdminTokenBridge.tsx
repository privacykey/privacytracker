'use client';

import { useEffect } from 'react';

export const ADMIN_TOKEN_SESSION_KEY = 'pt:admin-token';
export const ADMIN_TOKEN_CHANGED_EVENT = 'pt:admin-token-changed';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

/**
 * Installs a tiny same-origin fetch shim that attaches the session-scoped
 * admin token to mutating `/api/*` calls. This keeps LAN installs ergonomic:
 * users can unlock once in Settings, then normal destructive buttons work
 * without every component manually plumbing a token.
 */
export default function AdminTokenBridge() {
  useEffect(() => {
    const originalFetch = window.fetch.bind(window);
    const patchedFetch: typeof window.fetch = (input, init) => {
      const method = resolveMethod(input, init);
      const token = readAdminToken();
      if (token && MUTATING_METHODS.has(method) && isSameOriginApiRequest(input)) {
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
