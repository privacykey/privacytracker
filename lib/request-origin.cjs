"use strict";
function trustProxy() {
  return /^(1|true|yes|on)$/i.test(
    process.env.PRIVACYTRACKER_TRUST_PROXY?.trim() ?? ""
  );
}
function firstHeaderValue(headers, name) {
  return headers.get(name)?.split(",")[0]?.trim() || null;
}
/** @param {Headers} headers */
function effectiveHostFromHeaders(headers) {
  return (
    (trustProxy() && firstHeaderValue(headers, "x-forwarded-host")) ||
    headers.get("host")
  );
}
/** @param {Pick<Request, "url" | "headers">} request */
function requestOrigin(request) {
  const host = effectiveHostFromHeaders(request.headers);
  if (!host) {
    return null;
  }
  try {
    let protocol = new URL(request.url).protocol;
    if (trustProxy()) {
      const forwarded = firstHeaderValue(request.headers, "x-forwarded-proto");
      if (forwarded) {
        protocol = `${forwarded}:`;
      }
    }
    if (protocol !== "http:" && protocol !== "https:") {
      return null;
    }
    const url = new URL(`${protocol}//${host}`);
    if (url.username || url.password || url.pathname !== "/") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
/** @param {Pick<Request, "url" | "headers">} request */
function isSameOriginRequest(request) {
  const origin = request.headers.get("origin");
  const expected = requestOrigin(request);
  if (!(origin && expected)) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return parsed.origin === expected && origin === parsed.origin;
  } catch {
    return false;
  }
}
module.exports = {
  trustProxy,
  effectiveHostFromHeaders,
  requestOrigin,
  isSameOriginRequest,
};
