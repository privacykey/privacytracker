"use strict";
const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const ADMIN_TOKEN_COOKIE = "pt_admin_token";
/**
 * Where the per-boot session secret lives. A symbol on `globalThis`, because
 * the proxy and the route handlers can load separate copies of this module
 * and must derive the same cookie value. A harness pins the secret by
 * setting this global to a 32-byte Buffer before the first check.
 */
const SESSION_SECRET = Symbol.for("privacytracker.admin-session-secret");

/**
 * @param {string} a
 * @param {string} b
 */
function constantTimeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** @param {string | null} value */
function matchesToken(value) {
  const expected = process.env.AUDITOR_ADMIN_TOKEN;
  if (!(value && expected)) {
    return false;
  }
  return constantTimeEqual(value, expected);
}

/**
 * The secret this boot derives session cookies from: 32 random bytes,
 * minted the first time they are needed and kept for the life of the
 * process. A restart mints new ones, and that is what revokes every cookie
 * set before it.
 * @returns {Buffer}
 */
function adminSessionSecret() {
  const holder = /** @type {{ [SESSION_SECRET]?: unknown }} */ (globalThis);
  const current = holder[SESSION_SECRET];
  if (Buffer.isBuffer(current) && current.length > 0) {
    return current;
  }
  const minted = randomBytes(32);
  holder[SESSION_SECRET] = minted;
  return minted;
}

/**
 * What the login route puts in the cookie: HMAC-SHA256 of the configured
 * token under this boot's secret, as hex. It stands for the token without
 * carrying it, so a cookie that reaches a sibling service on the same host
 * (browsers scope cookies by host, never by port) does not disclose
 * AUDITOR_ADMIN_TOKEN, and it stops working at the next restart or token
 * rotation. Null while no token is configured.
 * `core/src/server/auth.rs` derives the same value.
 * @returns {string | null}
 */
function adminSessionCookieValue() {
  const token = process.env.AUDITOR_ADMIN_TOKEN;
  if (!token) {
    return null;
  }
  return createHmac("sha256", adminSessionSecret()).update(token).digest("hex");
}

/**
 * A cookie value is accepted when it is this boot's session value, or the
 * token itself (an integration that copied its header into a cookie keeps
 * working; knowing the token is what the header path already accepts).
 * @param {string} value
 */
function matchesCookie(value) {
  if (!value) {
    return false;
  }
  const session = adminSessionCookieValue();
  return (
    (session !== null && constantTimeEqual(value, session)) ||
    matchesToken(value)
  );
}

/** @param {Pick<Request, "headers">} request */
function requestHasValidAdminHeader(request) {
  return matchesToken(request.headers.get("x-auditor-admin-token"));
}

/**
 * The raw value of the first non-empty `pt_admin_token` cookie, trimmed,
 * before percent-decoding. Null when there is none. Used to count a wrong
 * cookie as a failed guess: one value per request, whatever else is planted
 * beside it, so a handful of foreign cookies cannot fill a client's guess
 * budget; the check below tries every one.
 * @param {string | null} cookieHeader
 */
function presentedAdminCookie(cookieHeader) {
  for (const part of (cookieHeader ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (part.slice(0, separator).trim() !== ADMIN_TOKEN_COOKIE) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * Whether the request carries a valid admin credential: the header, or any
 * `pt_admin_token` cookie. Every cookie of that name is tried. A browser
 * sends every cookie whose host and path match, so one planted by another
 * service on the same host (another port, or a parent domain) used to
 * shadow the real one when it came first and lock the operator out of
 * every private route; a value that fails to percent-decode is skipped the
 * same way.
 * @param {Pick<Request, "headers">} request
 */
function requestHasValidAdminToken(request) {
  if (requestHasValidAdminHeader(request)) {
    return true;
  }
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (part.slice(0, separator).trim() !== ADMIN_TOKEN_COOKIE) {
      continue;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      continue;
    }
    if (matchesCookie(decoded)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  ADMIN_TOKEN_COOKIE,
  adminSessionCookieValue,
  presentedAdminCookie,
  requestHasValidAdminHeader,
  requestHasValidAdminToken,
};
