import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";

const { guardRequest } = createRequire(import.meta.url)(
  "../../lib/request-limits.cjs"
);

async function listen(t: TestContext, timeoutMs?: number) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    if (timeoutMs && !guardRequest(req, res, { timeoutMs })) {
      return;
    }
    req.on("data", () => {});
    req.on("end", () => {
      if (!res.headersSent) {
        res.end("ok");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, calls: () => calls };
}

test("large import allowance requires authentication on a network deployment", async (t) => {
  const saved = process.env.AUDITOR_ADMIN_TOKEN;
  process.env.AUDITOR_ADMIN_TOKEN = "http-limit-test-only";
  t.after(() => {
    if (saved === undefined) {
      delete process.env.AUDITOR_ADMIN_TOKEN;
    } else {
      process.env.AUDITOR_ADMIN_TOKEN = saved;
    }
  });
  const server = await listen(t);
  const body = Buffer.alloc(1024 * 1024, 32);
  async function rejectedUpload(headers: Record<string, string> = {}) {
    return await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${server.url}/api/backup/preview`,
        {
          method: "POST",
          headers: { "Content-Length": String(body.length), ...headers },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        }
      );
      req.on("error", reject);
      // Header rejection must happen before the client sends the large body.
      req.flushHeaders();
    });
  }
  assert.equal(await rejectedUpload(), 413);
  assert.equal(
    await rejectedUpload({
      cookie: "pt_admin_token=http-limit-test-only",
      origin: "http://127.0.0.1:1",
    }),
    413
  );
  assert.equal(server.calls(), 0);
  const allowed = await fetch(`${server.url}/api/backup/preview`, {
    method: "POST",
    body,
    headers: { "x-auditor-admin-token": "http-limit-test-only" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), "ok");
  assert.equal(server.calls(), 1);
  const cookieUpload = await fetch(`${server.url}/api/backup/preview`, {
    method: "POST",
    body,
    headers: {
      cookie: "pt_admin_token=http-limit-test-only",
      origin: server.url,
    },
  });
  assert.equal(cookieUpload.status, 200);
  await cookieUpload.text();
  assert.equal(server.calls(), 2);
});

test("an unfinished HTTP upload hits its deadline before the handler completes", async (t) => {
  const server = await listen(t, 25);
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      server.url,
      { method: "POST", headers: { "Transfer-Encoding": "chunked" } },
      (res) => {
        res.resume();
        res.on("end", () => {
          req.destroy();
          resolve(res.statusCode ?? 0);
        });
      }
    );
    req.on("error", reject);
    req.write("unfinished");
  });
  assert.equal(status, 408);
});
