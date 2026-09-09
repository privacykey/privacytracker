/** Incremental request readers. Limits apply before buffering or parsing. */
export class RequestBodyError extends Error {
  readonly status: 408 | 413;
  constructor(status: 408 | 413, message: string) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}

export function requestBodyErrorResponse(error: unknown): Response | null {
  return error instanceof RequestBodyError
    ? Response.json({ error: error.message }, { status: error.status })
    : null;
}

export async function readBoundedBody(
  request: Request,
  maxBytes: number,
  timeoutMs = 30_000
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Invalid body limit");
  }
  const tooLarge = () =>
    new RequestBodyError(
      413,
      `Request body too large (limit ${maxBytes} bytes)`
    );
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    void request.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!request.body) {
    return Buffer.alloc(0);
  }

  const reader = request.body.getReader();
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new RequestBodyError(408, "Request body timed out")),
    timeoutMs
  );
  let onAbort = () => {};
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const consume = async () => {
      const chunks: Buffer[] = [];
      let current: Buffer | undefined;
      let offset = 0;
      let total = 0;
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value.byteLength > maxBytes - total) {
          throw tooLarge();
        }
        total += value.byteLength;
        // Coalesce tiny chunks so a byte-at-a-time upload cannot create an
        // unbounded number of Buffer objects relative to the payload size.
        let consumed = 0;
        while (consumed < value.byteLength) {
          if (!current || offset === current.length) {
            current = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
            chunks.push(current);
            offset = 0;
          }
          const length = Math.min(
            current.length - offset,
            value.byteLength - consumed
          );
          current.set(value.subarray(consumed, consumed + length), offset);
          offset += length;
          consumed += length;
        }
      }
      if (current) {
        chunks[chunks.length - 1] = current.subarray(0, offset);
      }
      return Buffer.concat(chunks, total);
    };
    return await Promise.race([consume(), aborted]);
  } catch (error) {
    // Do not wait for cancellation: a faulty/slow source may never settle it.
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export async function readBoundedJson<T = unknown>(
  request: Request,
  maxBytes = 256 * 1024
): Promise<T> {
  const body = await readBoundedBody(request, maxBytes);
  if (!body.length) {
    throw new Error("Request body is empty");
  }
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

export async function readOptionalBoundedJson<T = unknown>(
  request: Request,
  maxBytes: number,
  fallback: T
): Promise<T> {
  const body = await readBoundedBody(request, maxBytes);
  const text = body.toString("utf8");
  if (!text.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}
