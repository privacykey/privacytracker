'use client';

/**
 * Admin-token UI signal bus.
 *
 * The token itself is now stored in an HttpOnly cookie (set by
 * `/api/auth/admin-token/login` and cleared by `/api/auth/admin-token/logout`),
 * so JS — including any XSS payload — cannot read it from `sessionStorage`
 * any more. The browser auto-attaches the cookie to same-origin /api/*
 * requests, so this component no longer needs to install a fetch shim.
 *
 * Two exports remain:
 *   - `ADMIN_TOKEN_CHANGED_EVENT`: components can listen for this to
 *     refresh their "locked / unlocked" pills after a successful login/
 *     logout in another tab or panel.
 *   - The default export is a no-op marker component, kept so the layout
 *     tree doesn't need to be re-shuffled.
 */

export const ADMIN_TOKEN_CHANGED_EVENT = 'pt:admin-token-changed';

export default function AdminTokenBridge() {
  return null;
}
