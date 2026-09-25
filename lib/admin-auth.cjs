"use strict";
const { timingSafeEqual } = require("node:crypto");
const ADMIN_TOKEN_COOKIE = "pt_admin_token";

/** @param {string | null} value */
function matchesToken(value) {
  const expected = process.env.AUDITOR_ADMIN_TOKEN;
  if (!(value && expected)) {
    return false;
  }
  const provided = Buffer.from(value);
  const secret = Buffer.from(expected);
  return provided.length === secret.length && timingSafeEqual(provided, secret);
}

/** @param {Pick<Request, "headers">} request */
function requestHasValidAdminHeader(request) {
  return matchesToken(request.headers.get("x-auditor-admin-token"));
}

/**
 * The raw value of the admin-token cookie the check below reads: the FIRST
 * `pt_admin_token`, trimmed, before percent-decoding. Null when there is
 * none or it is empty. Used to count a wrong cookie as a failed guess.
 * @param {string | null} cookieHeader
 */
function presentedAdminCookie(cookieHeader) {
  for (const part of (cookieHeader ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (part.slice(0, separator).trim() !== ADMIN_TOKEN_COOKIE) {
      continue;
    }
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

/** @param {Pick<Request, "headers">} request */
function requestHasValidAdminToken(request) {
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

module.exports = {
  ADMIN_TOKEN_COOKIE,
  presentedAdminCookie,
  requestHasValidAdminHeader,
  requestHasValidAdminToken,
};
