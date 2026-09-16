/** Actual Node URL policy and safeFetch over a disposable HTTP server. */

import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
} from "node:zlib";

process.env.NEXT_PHASE = "phase-test";
process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = "1";
const {
  validateExternalUrl,
  validateAppStoreUrl,
  sanitizePolicyUrl,
  safeFetch,
} = await import("../../lib/security.ts");
const { isPrivateIpv4, isPrivateIpv6, isMetadataHost } = await import(
  "../../lib/network-address.ts"
);
// RFC 1952's OS byte describes the compressor's host, not response behavior.
// Use the specified "unknown" value so macOS and Linux emit identical inputs.
const portableGzip = (input) => {
  const compressed = gzipSync(input);
  compressed[9] = 255;
  return compressed;
};

const hosts = ["apps.apple.com", "itunes.apple.com"];
const urls = [
  "",
  " ",
  "\ufeff",
  "no url",
  "/relative",
  "https://",
  "https://[broken]/",
  "javascript:alert(1)",
  "data:text/plain,hi",
  "ftp://example.com/a",
  "mailto:a@b.c",
  "https://apps.apple.com/us/app/a/id123",
  " HTTP://APPS.APPLE.COM:80/a/id123?x=1#f ",
  "https://apps.apple.com./a/id123",
  "https://apps.apple.com/a/ID123/",
  "https://itunes.apple.com/a/id12?x=1",
  "https://apps.apple.com/a/id1extra",
  "https://apps.apple.com/a/id",
  "https://apps.apple.com/a/%69d12",
  "https://apps.apple.com/a/id12%3Fhi",
  "https://apps.apple.com/a/id12/../other",
  "https:\\apps.apple.com\\a\\id12",
  "https://user:pass@apps.apple.com/a/id12",
  "https://user@apps.apple.com/a/id12",
  "https://:@apps.apple.com/a/id12",
  "https://apps.apple.com.evil.test/a/id12",
  "https://sub.apps.apple.com/a/id12",
  "https://example.com/a/id12",
  "https://localhost/a/id12",
  "http://localhost.localdomain/",
  "http://ip6-loopback/",
  "http://metadata/",
  "http://metadata.google.internal/",
  "http://127.1/id12",
  "http://0x7f000001/id12",
  "http://2130706433/id12",
  "http://0177.0.0.1/id12",
  "http://10.0.0.1/",
  "http://169.254.169.254/",
  "http://172.16.0.1/",
  "http://192.168.1.1/",
  "http://100.64.0.1/",
  "http://224.0.0.1/",
  "http://8.8.8.8/id12",
  "http://[::1]/id12",
  "http://[::ffff:127.0.0.1]/id12",
  "http://[fe80::1]/",
  "http://[fd00:ec2::254]/",
  "http://[2001:4860:4860::8888]/",
  "http://[2002:0808:0808::1]/",
  "http://[2001:0:1::1]/",
  "https://éxample.com/",
  "https://apps.apple.com/a/id123?unicode=λ",
  "https://apps.apple.com/a/id123\n",
  `https://apps.apple.com/a/id123?${"a".repeat(2048)}`,
  `https://apps.apple.com/a/id123?${"😀".repeat(1024)}`,
];
const validation = [];
for (const raw of urls) {
  for (const kind of ["external", "apple", "policy"]) {
    const value =
      kind === "apple"
        ? validateAppStoreUrl(raw)
        : kind === "policy"
          ? sanitizePolicyUrl(raw)
          : validateExternalUrl(raw, { allowedHosts: hosts });
    validation.push({
      raw,
      kind,
      expected:
        typeof value === "string"
          ? value
          : value.ok
            ? { ok: true, url: value.url.toString() }
            : value,
    });
  }
}
const addresses = [
  "0.1.2.3",
  "10.0.0.1",
  "127.0.0.1",
  "169.254.0.1",
  "172.15.1.1",
  "172.16.1.1",
  "172.31.1.1",
  "172.32.1.1",
  "192.168.1.1",
  "100.63.1.1",
  "100.64.1.1",
  "100.127.1.1",
  "100.128.1.1",
  "223.1.1.1",
  "224.1.1.1",
  "255.255.255.255",
  "8.8.8.8",
  "::",
  "::1",
  "::ffff:8.8.8.8",
  "::ffff:192.168.1.1",
  "64:ff9b::808:808",
  "2001:4860::8888",
  "2002:808:808::1",
  "2001:0:1::1",
  "fc00::1",
  "fd00:ec2::254",
  "fe80::1",
  "febf::1",
  "fec0::1",
  "ff02::1",
].map((ip) => ({
  ip,
  private: isPrivateIpv4(ip) || isPrivateIpv6(ip),
  metadata: isMetadataHost(ip),
}));

const bytes = (s) => [...Buffer.from(s)];
const reply = (body = "ok", headers = {}, status = 200) => ({
  status,
  headers,
  body: bytes(body),
});
const scenarios = [
  { name: "plain response", steps: [reply("hello λ")] },
  { name: "non-success status is a response", steps: [reply("busy", {}, 429)] },
  {
    name: "redirect without location is a response",
    steps: [reply("no location", {}, 302)],
  },
  {
    name: "relative redirect",
    steps: [reply("", { location: "/next?x=1" }, 302), reply("done")],
  },
  {
    name: "cross-origin strips credentials",
    steps: [
      reply("", { location: "http://itunes.apple.com/next" }, 302),
      reply("done"),
    ],
  },
  {
    name: "same-origin retains credentials",
    steps: [reply("", { location: "/next" }, 307), reply("done")],
  },
  {
    name: "private redirect",
    steps: [reply("", { location: "http://127.0.0.1/private" }, 302)],
  },
  {
    name: "disallowed redirect",
    steps: [reply("", { location: "http://example.com/private" }, 302)],
  },
  {
    name: "credential redirect",
    steps: [reply("", { location: "http://user@apps.apple.com/private" }, 302)],
  },
  {
    name: "invalid redirect",
    steps: [reply("", { location: "http://[broken]/" }, 302)],
  },
  { name: "redirect cap", steps: [reply("", { location: "/again" }, 302)] },
  { name: "exact byte cap", steps: [reply("x".repeat(64))] },
  {
    name: "declared byte cap",
    steps: [reply("x".repeat(65), { "content-length": "65" })],
  },
  { name: "stream byte cap", steps: [reply("x".repeat(65))] },
  {
    name: "gzip",
    steps: [
      {
        ...reply(),
        headers: { "content-encoding": "gzip" },
        body: [...portableGzip("compressed λ")],
      },
    ],
  },
  {
    name: "brotli",
    steps: [
      {
        ...reply(),
        headers: { "content-encoding": "br" },
        body: [...brotliCompressSync("compressed λ")],
      },
    ],
  },
  {
    name: "zlib",
    steps: [
      {
        ...reply(),
        headers: { "content-encoding": "deflate" },
        body: [...deflateSync("compressed λ")],
      },
    ],
  },
  {
    name: "raw deflate",
    steps: [
      {
        ...reply(),
        headers: { "content-encoding": "deflate" },
        body: [...deflateRawSync("compressed λ")],
      },
    ],
  },
  {
    name: "gzip decoded byte cap",
    steps: [
      {
        ...reply(),
        headers: { "content-encoding": "gzip" },
        body: [...portableGzip("x".repeat(2048))],
      },
    ],
  },
  {
    name: "invalid gzip",
    steps: [reply("bad gzip", { "content-encoding": "gzip" })],
  },
  {
    name: "header timeout",
    timeout_ms: 500,
    steps: [{ ...reply(), delay_headers_ms: 1500 }],
  },
  {
    name: "body timeout",
    timeout_ms: 500,
    steps: [{ ...reply(), delay_body_ms: 1500 }],
  },
];
let active;
let calls;
let cursor;
const server = createServer(async (req, res) => {
  calls.push({
    host: req.headers["x-fixture-host"],
    path: req.url,
    authorization: req.headers.authorization ?? null,
    cookie: req.headers.cookie ?? null,
  });
  const step = active.steps[Math.min(cursor++, active.steps.length - 1)];
  if (step.delay_headers_ms) {
    await new Promise((r) => setTimeout(r, step.delay_headers_ms));
  }
  if (res.destroyed) {
    return;
  }
  res.writeHead(step.status, step.headers);
  res.flushHeaders();
  if (step.delay_body_ms) {
    await new Promise((r) => setTimeout(r, step.delay_body_ms));
  }
  if (!res.destroyed) {
    res.end(Buffer.from(step.body));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const original = globalThis.fetch;
// The real Node HTTP stack still handles decompression and streaming. Only
// the test's final destination is rewritten to its disposable local server.
globalThis.fetch = (input, init) => {
  const u = new URL(input);
  return original(`http://127.0.0.1:${port}${u.pathname}${u.search}`, {
    ...init,
    headers: { ...init.headers, "x-fixture-host": u.host, connection: "close" },
  });
};
const transport = [];
try {
  for (const scenario of scenarios) {
    active = scenario;
    calls = [];
    cursor = 0;
    const request = {
      url: "http://apps.apple.com/start",
      allowed_hosts: hosts,
      headers: [
        ["authorization", "test-secret"],
        ["cookie", "fixture=1"],
      ],
      max_bytes: 64,
      timeout_ms: scenario.timeout_ms ?? 2000,
      max_redirects: 2,
    };
    let expected;
    try {
      const r = await safeFetch(request.url, {
        allowedHosts: hosts,
        headers: Object.fromEntries(request.headers),
        maxBytes: request.max_bytes,
        timeoutMs: request.timeout_ms,
        maxRedirects: 2,
        redirect: "follow",
      });
      expected = { status: r.response.status, body: [...r.body] };
    } catch (e) {
      expected = { error: e.message };
    }
    if (!calls.length) {
      throw new Error(
        `Transport fixture did not reach its server: ${scenario.name}`
      );
    }
    transport.push({ ...scenario, request, expected, calls });
  }
} finally {
  globalThis.fetch = original;
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}
writeFileSync(
  new URL("../tests/fixtures/outbound-cases.json", import.meta.url),
  `${JSON.stringify({ validation, addresses, transport }, null, 2)}\n`
);
console.log(
  `Generated ${validation.length} URL cases, ${addresses.length} address cases and ${transport.length} real HTTP transport cases.`
);
