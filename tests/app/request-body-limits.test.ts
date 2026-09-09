import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  RequestBodyError,
  readBoundedBody,
  readBoundedJson,
  readOptionalBoundedJson,
} from "../../lib/request-body";

function streamedRequest(
  maxChunks: number,
  chunkSize: number,
  headers: Record<string, string> = {}
) {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      controller.enqueue(new Uint8Array(chunkSize).fill(32));
      if (reads >= maxChunks) {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost/api/test", {
    method: "POST",
    body,
    duplex: "half",
    headers,
  } as RequestInit);
  return { request, reads: () => reads, cancelled: () => cancelled };
}

test("chunked and falsely small Content-Length bodies stop near the cap and cancel", async () => {
  const cases: Record<string, string>[] = [{}, { "content-length": "1" }];
  for (const headers of cases) {
    const input = streamedRequest(1000, 512, headers);
    await assert.rejects(
      readBoundedBody(input.request, 1024),
      (error: unknown) =>
        error instanceof RequestBodyError && error.status === 413
    );
    assert.equal(input.cancelled(), true);
    assert.ok(input.reads() <= 4, `read ${input.reads()} chunks`);
  }
});

test("declared oversize is rejected and cancelled without draining the body", async () => {
  const input = streamedRequest(1000, 512, { "content-length": "512000" });
  await assert.rejects(readBoundedBody(input.request, 1024), { status: 413 });
  assert.equal(input.cancelled(), true);
  assert.ok(input.reads() <= 1);
});

test("byte-at-a-time uploads preserve exact bytes, including a partial final block", async () => {
  const expected = Buffer.from("😀".repeat(20_000));
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(expected.subarray(index, ++index));
      if (index === expected.length) {
        controller.close();
      }
    },
  });
  const request = new Request("http://localhost/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
  assert.deepEqual(await readBoundedBody(request, expected.length), expected);
});

test("slow bodies time out even if stream cancellation never settles", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  const request = new Request("http://localhost/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(readBoundedBody(request, 1024, 20), { status: 408 });
  assert.equal(cancelled, true);
});

test("client abort cancels an in-progress body read", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost/", {
    method: "POST",
    body,
    duplex: "half",
    signal: abort.signal,
  } as RequestInit);
  const reading = readBoundedBody(request, 1024);
  abort.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("JSON readers preserve optional empty bodies and enforce the byte limit before parsing", async () => {
  const req = (body: string) =>
    new Request("http://localhost/", { method: "POST", body });
  assert.equal(await readOptionalBoundedJson(req(" \n"), 10, null), null);
  assert.deepEqual(await readBoundedJson(req('{"name":"中文"}'), 32), {
    name: "中文",
  });
  await assert.rejects(readBoundedJson(req(""), 10), /empty/);
  await assert.rejects(readBoundedJson(req("invalid"), 10), /Invalid JSON/);
  await assert.rejects(
    readOptionalBoundedJson(req(" ".repeat(100)), 10, null),
    { status: 413 }
  );
});

test("login reports 413 for a chunked oversized body", async () => {
  const savedToken = process.env.AUDITOR_ADMIN_TOKEN;
  process.env.AUDITOR_ADMIN_TOKEN = "request-body-test-only";
  try {
    const { POST } = await import("../../app/api/auth/admin-token/login/route");
    const input = streamedRequest(1000, 1024, {
      host: "localhost",
      origin: "http://localhost",
    });
    const response = await POST(new NextRequest(input.request));
    assert.equal(response.status, 413);
    await new Promise(setImmediate);
    assert.ok(input.reads() < 10);
    assert.equal(input.cancelled(), true);
  } finally {
    if (savedToken === undefined) {
      delete process.env.AUDITOR_ADMIN_TOKEN;
    } else {
      process.env.AUDITOR_ADMIN_TOKEN = savedToken;
    }
  }
});

test("multipart upload is bounded before form parsing", async () => {
  const { POST } = await import("../../app/api/import/audit-bundle/route");
  const input = streamedRequest(1000, 64 * 1024, {
    "content-type": "multipart/form-data; boundary=test",
  });
  const response = await POST(new NextRequest(input.request));
  assert.equal(response.status, 413);
  await new Promise(setImmediate);
  assert.equal(input.cancelled(), true);
  // NextRequest adds a stream adapter with its own small prefetch queue.
  assert.ok(input.reads() <= 132, `read ${input.reads()} chunks`);
});

test("backup preview rejects declared oversize before buffering", async () => {
  const { POST } = await import("../../app/api/backup/preview/route");
  const input = streamedRequest(1000, 1024, {
    "content-length": String(100 * 1024 * 1024 + 1),
  });
  assert.equal((await POST(input.request)).status, 413);
  assert.equal(input.cancelled(), true);
  assert.ok(input.reads() <= 1);
});
