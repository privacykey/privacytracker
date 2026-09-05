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
  requestHasValidAdminHeader,
  requestHasValidAdminToken,
};
