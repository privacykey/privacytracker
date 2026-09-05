import { timingSafeEqual } from "node:crypto";

export const ADMIN_TOKEN_COOKIE = "pt_admin_token";

function matchesToken(value: string | null): boolean {
  const expected = process.env.AUDITOR_ADMIN_TOKEN;
  if (!(value && expected)) {
    return false;
  }
  const provided = Buffer.from(value);
  const secret = Buffer.from(expected);
  return provided.length === secret.length && timingSafeEqual(provided, secret);
}

/** Only an explicitly supplied header can exempt a caller from CSRF checks. */
export function requestHasValidAdminHeader(request: Request): boolean {
  return matchesToken(request.headers.get("x-auditor-admin-token"));
}

/** Browser cookies authenticate a request, but never establish its origin. */
export function requestHasValidAdminToken(request: Request): boolean {
  if (requestHasValidAdminHeader(request)) {
    return true;
  }
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (part.slice(0, separator).trim() !== ADMIN_TOKEN_COOKIE) {
      continue;
    }
    try {
      return matchesToken(decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      return false;
    }
  }
  return false;
}
