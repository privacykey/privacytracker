import assert from "node:assert/strict";
import { promises as dns } from "node:dns";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import test, { type TestContext } from "node:test";
import { outboundDispatcher } from "../../lib/outbound-dispatcher";
import {
  safeFetch,
  safeFetchStream,
  validateExternalUrl,
} from "../../lib/security";

test.after(async () => {
  await Promise.all([
    outboundDispatcher(false).destroy(),
    outboundDispatcher(true).destroy(),
  ]);
});

async function canary(
  t: TestContext,
  handler?: (req: IncomingMessage, res: ServerResponse) => void
) {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    if (handler) {
      handler(req, res);
    } else {
      res.end("local-model-response");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { port: address.port, calls: () => calls };
}

function isBlocked(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /Blocked URL/.test(error.message) || isBlocked(error.cause);
}

test("mapped IPv6 private addresses and metadata are checked in canonical and expanded forms", () => {
  for (const host of [
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:a00:1",
    "::ffff:c0a8:101",
    "::1",
    "0:0:0:0:0:0:0:1",
    "64:ff9b::7f00:1",
  ]) {
    assert.equal(validateExternalUrl(`http://[${host}]/`).ok, false, host);
  }
  for (const host of [
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:a9fe:aa02",
    "fd00:0ec2:0:0:0:0:0:0254",
  ]) {
    assert.equal(
      validateExternalUrl(`http://[${host}]/`, { allowPrivateHosts: true }).ok,
      false,
      host
    );
  }
  assert.equal(
    validateExternalUrl("http://metadata.google.internal./", {
      allowPrivateHosts: true,
    }).ok,
    false
  );
  assert.equal(validateExternalUrl("https://[2606:4700:4700::1111]/").ok, true);
  assert.equal(validateExternalUrl("http://[::ffff:808:808]/").ok, true);
});

test("mapped loopback never reaches a real local listener for public-only callers", async (t) => {
  const local = await canary(t);
  await assert.rejects(
    safeFetch(`http://[::ffff:7f00:1]:${local.port}/`, {
      resolveAndCheck: true,
    }),
    isBlocked
  );
  assert.equal(local.calls(), 0);
});

for (const streaming of [false, true]) {
  test(`${streaming ? "streaming" : "buffered"} fetch rejects DNS changing from public preflight to private connection`, async (t) => {
    const local = await canary(t);
    let lookups = 0;
    t.mock.method(dns, "lookup", async () => [
      { address: lookups++ === 0 ? "8.8.8.8" : "127.0.0.1", family: 4 },
    ]);
    const fetcher = streaming ? safeFetchStream : safeFetch;
    await assert.rejects(
      fetcher(`http://rebind-${streaming}.example:${local.port}/`, {
        resolveAndCheck: true,
      }),
      isBlocked
    );
    assert.equal(lookups, 2);
    assert.equal(local.calls(), 0);
  });
}

test("local AI remains usable, preserving hostname and explicitly supplied credentials", async (t) => {
  let host = "";
  let credential = "";
  const local = await canary(t, (req, res) => {
    host = req.headers.host ?? "";
    credential = req.headers.authorization ?? "";
    res.end("local-model-response");
  });
  t.mock.method(dns, "lookup", async () => [
    { address: "127.0.0.1", family: 4 },
  ]);
  const response = await safeFetchStream(
    `http://local-model.example:${local.port}/`,
    {
      allowPrivateHosts: true,
      resolveAndCheck: true,
      headers: { Authorization: "Bearer test-only" },
    }
  );
  assert.equal(await response.text(), "local-model-response");
  assert.equal(host, `local-model.example:${local.port}`);
  assert.equal(credential, "Bearer test-only");
  assert.equal(local.calls(), 1);
  assert.notEqual(outboundDispatcher(false), outboundDispatcher(true));
});

test("local-AI exception still blocks metadata returned only at socket connection time", async (t) => {
  let lookups = 0;
  t.mock.method(dns, "lookup", async () => [
    {
      address: lookups++ === 0 ? "8.8.8.8" : "::ffff:a9fe:a9fe",
      family: lookups === 1 ? 4 : 6,
    },
  ]);
  await assert.rejects(
    safeFetchStream("http://metadata-rebind.example/v1", {
      allowPrivateHosts: true,
      resolveAndCheck: true,
    }),
    isBlocked
  );
  assert.equal(lookups, 2);
});

test("redirect targets also use the connection-time metadata gate", async (t) => {
  const local = await canary(t, (_, res) => {
    res.writeHead(302, { Location: "http://redirect-rebind.example/v1" });
    res.end();
  });
  let targetLookups = 0;
  t.mock.method(dns, "lookup", async (hostname: string) => [
    {
      address:
        hostname === "redirect-start.example"
          ? "127.0.0.1"
          : targetLookups++ === 0
            ? "8.8.8.8"
            : "169.254.169.254",
      family: 4,
    },
  ]);
  await assert.rejects(
    safeFetch(`http://redirect-start.example:${local.port}/`, {
      allowPrivateHosts: true,
      resolveAndCheck: true,
      redirect: "follow",
    }),
    isBlocked
  );
  assert.equal(targetLookups, 2);
  assert.equal(local.calls(), 1);
});

test("DNS preflight is included in the overall request deadline", async (t) => {
  t.mock.method(dns, "lookup", () => new Promise(() => {}));
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      safeFetch("http://slow-dns.example/", {
        resolveAndCheck: true,
        timeoutMs: 20,
      }),
      { name: "TimeoutError" }
    );
  } finally {
    clearTimeout(keepAlive);
  }
});
