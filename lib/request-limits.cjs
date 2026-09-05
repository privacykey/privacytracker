"use strict";
/**
 * Install before Next starts: its Proxy clones and buffers bodies before routes.
 * Observe raw IncomingMessage events without putting the stream into flowing
 * mode, so byte limits and a deadline apply before that framework buffer.
 */
const http = require("node:http");
const https = require("node:https");
const {
  requestHasValidAdminHeader,
  requestHasValidAdminToken,
} = require("./admin-auth.cjs");
const { isSameOriginRequest } = require("./request-origin.cjs");

const KIB = 1024;
const MIB = KIB * KIB;
const installed = Symbol.for("privacytracker.request-limits.installed");

function bodyLimit(url, largeUploadsAllowed = false) {
  let path;
  try {
    path = decodeURIComponent(
      new URL(url, "http://localhost").pathname
    ).replace(/\/+$/, "");
  } catch {
    return 4 * KIB;
  }
  if (path === "/api/auth/admin-token/login") {
    return 4 * KIB;
  }
  if (
    largeUploadsAllowed &&
    (path === "/api/backup/preview" || path === "/api/backup/restore")
  ) {
    return 100 * MIB;
  }
  if (largeUploadsAllowed && path === "/api/import/audit-bundle") {
    return 8 * MIB;
  }
  // The largest ordinary JSON endpoint is device-sync preview (512 KiB).
  // Each route also enforces its own, generally much smaller, parsing limit.
  return 512 * KIB;
}

function guardRequest(request, response, options = {}) {
  const headers = {
    get(name) {
      const value = request.headers[name.toLowerCase()];
      return typeof value === "string" ? value : null;
    },
  };
  const explicitLocal =
    !process.env.AUDITOR_ADMIN_TOKEN &&
    ["127.0.0.1", "::1", "localhost"].includes(
      process.env.PRIVACYTRACKER_BIND_HOST
    ) &&
    !/^(1|true|yes|on)$/i.test(
      process.env.PRIVACYTRACKER_NETWORK_EXPOSED ?? ""
    ) &&
    !process.env.PRIVACYTRACKER_ALLOWED_HOSTS?.trim();
  const originRequest = {
    headers,
    url: `${request.socket.encrypted ? "https" : "http"}://localhost${request.url}`,
  };
  const authenticatedUpload =
    requestHasValidAdminHeader({ headers }) ||
    (requestHasValidAdminToken({ headers }) &&
      isSameOriginRequest(originRequest));
  const maxBytes =
    options.maxBytes ??
    bodyLimit(request.url, explicitLocal || authenticatedUpload);
  let bytes = 0;
  let rejected = false;
  const originalEmit = request.emit;
  const timer = setTimeout(
    () => reject(408, "Request body timed out"),
    options.timeoutMs ?? 30_000
  );
  timer.unref();

  function cleanup() {
    clearTimeout(timer);
  }
  function reject(status, message) {
    if (rejected) {
      return;
    }
    rejected = true;
    cleanup();
    // Keep an error listener for header-only rejection, when Next never ran.
    request.once("error", () => {});
    if (response.headersSent) {
      request.destroy();
      return;
    }
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    });
    response.once("finish", () => request.destroy(new Error(message)));
    response.end(JSON.stringify({ error: message }));
  }

  request.emit = function emit(event, ...args) {
    if (event === "data") {
      if (rejected) {
        return false;
      }
      bytes += Buffer.byteLength(args[0]);
      if (bytes > maxBytes) {
        reject(413, `Request body too large (limit ${maxBytes} bytes)`);
        return false;
      }
    }
    return Reflect.apply(originalEmit, this, [event, ...args]);
  };
  request.once("end", cleanup);
  request.once("close", cleanup);
  response.once("finish", () => {
    cleanup();
    if (!(rejected || request.complete)) {
      request.once("error", () => {});
      request.destroy(new Error("Response completed before request body"));
    }
  });
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    reject(413, `Request body too large (limit ${maxBytes} bytes)`);
  }
  return !rejected;
}

for (const prototype of [http.Server.prototype, https.Server.prototype]) {
  if (prototype[installed]) {
    continue;
  }
  const originalEmit = prototype.emit;
  prototype.emit = function emit(event, ...args) {
    if (event === "request" && !guardRequest(args[0], args[1])) {
      return true;
    }
    return Reflect.apply(originalEmit, this, [event, ...args]);
  };
  prototype[installed] = true;
}

module.exports = { bodyLimit, guardRequest };
