/**
 * Validator for the runtime-diagnostics envelope — the executable form of
 * the contract in `lib/runtime-diagnostics-envelope.ts`.
 *
 * Plain JavaScript on purpose: it is imported by the parity harness (plain
 * `node`, no loader) to hold BOTH backends to the same shape, and by
 * `tests/app/runtime-diagnostics.test.ts` to hold the Node snapshot to it.
 * Two backends cannot be byte-compared on these routes — a V8 heap and a
 * Rust allocator are different sections by design — so "each side emits
 * the contract" is the check, and this file is the contract.
 *
 * `validateRuntimeDiagnostics(value)` returns a list of problems (empty
 * when valid). Every problem names the dotted path, so a failure reads as
 * "heap.heapFractionUsed: expected number, got string".
 */

export const RUNTIME_DIAGNOSTICS_SCHEMA_VERSION = 2;

const LAG_NUMBERS = [
  "windowSeconds",
  "samples",
  "minMs",
  "meanMs",
  "maxMs",
  "stddevMs",
  "p50Ms",
  "p95Ms",
  "p99Ms",
];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function check(errors, path, value, spec) {
  // spec: "number" | "number?" | "string" | "string?" | "boolean" | "array"
  //     | ["a", "b"] (enum) | { ...nested spec } | { $nullable: {...} }
  if (Array.isArray(spec)) {
    if (!spec.includes(value)) {
      errors.push(
        `${path}: expected one of ${spec.map((s) => JSON.stringify(s)).join(", ")}, got ${JSON.stringify(value)}`
      );
    }
    return;
  }
  if (typeof spec === "string") {
    const optional = spec.endsWith("?");
    const type = optional ? spec.slice(0, -1) : spec;
    if (value === null && optional) {
      return;
    }
    if (type === "array") {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${describe(value)}`);
      }
      return;
    }
    const ok = type === "number" ? isNum(value) : typeof value === type;
    if (!ok) {
      errors.push(
        `${path}: expected ${type}${optional ? " or null" : ""}, got ${describe(value)}`
      );
    }
    return;
  }
  if (isObj(spec) && "$nullable" in spec) {
    if (value === null) {
      return;
    }
    check(errors, path, value, spec.$nullable);
    return;
  }
  if (!isObj(value)) {
    errors.push(`${path}: expected object, got ${describe(value)}`);
    return;
  }
  for (const [key, sub] of Object.entries(spec)) {
    check(errors, `${path}.${key}`, value[key], sub);
  }
  for (const key of Object.keys(value)) {
    if (!(key in spec)) {
      errors.push(`${path}.${key}: unexpected key`);
    }
  }
}

function describe(v) {
  if (v === null) {
    return "null";
  }
  if (typeof v === "number" && !Number.isFinite(v)) {
    return String(v);
  }
  if (v === undefined) {
    return "missing";
  }
  if (Array.isArray(v)) {
    return "array";
  }
  return typeof v;
}

const LAG = Object.fromEntries(LAG_NUMBERS.map((k) => [k, "number"]));
// No samples → no mean and no deviation. Null, not NaN (which JSON cannot
// carry and would arrive as null regardless).
LAG.meanMs = "number?";
LAG.stddevMs = "number?";
LAG.severity = ["ok", "warn", "danger"];

const PROCESS = {
  pid: "number",
  rssMb: "number",
  peakRssMb: "number?",
  virtualMb: "number?",
  threads: "number?",
  openFds: "number?",
  userCpuSeconds: "number",
  systemCpuSeconds: "number",
  minorPageFaults: "number",
  majorPageFaults: "number",
  voluntaryContextSwitches: "number",
  involuntaryContextSwitches: "number",
};

const HEAP_BY_KIND = {
  v8: {
    kind: ["v8"],
    heapTotalMb: "number",
    heapUsedMb: "number",
    externalMb: "number",
    arrayBuffersMb: "number",
    totalHeapSizeMb: "number",
    usedHeapSizeMb: "number",
    heapSizeLimitMb: "number",
    mallocedMemoryMb: "number",
    externalMemoryMb: "number",
    heapFractionUsed: "number",
  },
  "rust-allocator": {
    kind: ["rust-allocator"],
    allocatedMb: "number",
    peakMb: "number",
    liveAllocations: "number",
  },
};

const SQLITE = {
  engine: ["better-sqlite3", "rusqlite"],
  version: "string?",
  connectionModel: ["single-sync", "single-mutex"],
  memory: {
    $nullable: {
      usedMb: "number",
      highwaterMb: "number",
      pageCacheMb: "number",
      schemaKb: "number",
      statementsKb: "number",
    },
  },
  cache: {
    $nullable: {
      hits: "number",
      misses: "number",
      writes: "number",
      spills: "number",
    },
  },
  lockWait: { $nullable: LAG },
};

const SCHEDULER_BY_KIND = {
  "event-loop": { kind: ["event-loop"], lag: { $nullable: LAG } },
  tokio: {
    kind: ["tokio"],
    workers: "number",
    aliveTasks: "number",
    globalQueueDepth: "number",
    lag: { $nullable: LAG },
  },
};

const HTTP = {
  inFlight: "number?",
  thresholdMs: "number",
  totalSinceStart: "number",
  slowSinceStart: "number",
  recent: "array",
};

const SLOW_QUERIES = {
  thresholdMs: "number",
  totalSinceStart: "number",
  profilingEnabled: "boolean",
  recent: "array",
};

const DB_WORKER = {
  $nullable: {
    totalSinceStart: "number",
    failedSinceStart: "number",
    inlineSinceStart: "number",
    pendingRequests: "number",
    workerEnabled: "boolean",
    workerCached: "boolean",
    workerDisabled: "boolean",
    recent: "array",
  },
};

const SCRAPE_ACTIVITY = {
  $nullable: {
    totalSinceStart: "number",
    inProgress: "array",
    recent: "array",
  },
};

const RATE_LIMITER = {
  $nullable: { trackedKeys: "number", denialsSinceStart: "number?" },
};

const TOP_LEVEL_KEYS = [
  "backend",
  "schemaVersion",
  "generatedAt",
  "uptimeSeconds",
  "process",
  "heap",
  "sqlite",
  "scheduler",
  "http",
  "slowQueries",
  "dbWorker",
  "scrapeActivity",
  "rateLimiter",
];

/**
 * `GET /api/diagnostics/errors`: `{ entries: [{at, level, message,
 * truncated}], capacity }`, newest first. Its contents are per-process by
 * definition, so this is the whole contract.
 */
export function validateErrorLog(value) {
  const errors = [];
  if (!isObj(value)) {
    return [`$: expected object, got ${describe(value)}`];
  }
  check(errors, "capacity", value.capacity, "number");
  if (!Array.isArray(value.entries)) {
    errors.push(`entries: expected array, got ${describe(value.entries)}`);
    return errors;
  }
  value.entries.forEach((e, i) => {
    check(errors, `entries[${i}]`, e, {
      at: "number",
      level: ["error", "warn"],
      message: "string",
      truncated: "boolean",
    });
  });
  for (let i = 1; i < value.entries.length; i += 1) {
    if (value.entries[i - 1]?.at < value.entries[i]?.at) {
      errors.push(`entries[${i}]: not newest-first`);
      break;
    }
  }
  if (
    typeof value.capacity === "number" &&
    value.entries.length > value.capacity
  ) {
    errors.push(
      `entries: ${value.entries.length} entries exceeds capacity ${value.capacity}`
    );
  }
  for (const key of Object.keys(value)) {
    if (!["entries", "capacity"].includes(key)) {
      errors.push(`${key}: unexpected top-level key`);
    }
  }
  return errors;
}

/**
 * Validate one envelope. Returns `[]` when it conforms; otherwise one
 * message per problem, dotted-path first.
 */
export function validateRuntimeDiagnostics(value) {
  const errors = [];
  if (!isObj(value)) {
    return [`$: expected object, got ${describe(value)}`];
  }
  check(errors, "backend", value.backend, ["node", "rust"]);
  check(errors, "schemaVersion", value.schemaVersion, [
    RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
  ]);
  check(errors, "generatedAt", value.generatedAt, "string");
  if (
    typeof value.generatedAt === "string" &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.generatedAt)
  ) {
    errors.push(
      `generatedAt: expected an ISO timestamp, got ${JSON.stringify(value.generatedAt)}`
    );
  }
  check(errors, "uptimeSeconds", value.uptimeSeconds, "number");
  check(errors, "process", value.process, PROCESS);

  const heapKind = value.heap?.kind;
  if (heapKind in HEAP_BY_KIND) {
    check(errors, "heap", value.heap, HEAP_BY_KIND[heapKind]);
  } else {
    errors.push(
      `heap.kind: expected one of "v8", "rust-allocator", got ${JSON.stringify(heapKind)}`
    );
  }

  check(errors, "sqlite", value.sqlite, SQLITE);

  const schedKind = value.scheduler?.kind;
  if (schedKind in SCHEDULER_BY_KIND) {
    check(errors, "scheduler", value.scheduler, SCHEDULER_BY_KIND[schedKind]);
  } else {
    errors.push(
      `scheduler.kind: expected one of "event-loop", "tokio", got ${JSON.stringify(schedKind)}`
    );
  }

  check(errors, "http", value.http, HTTP);
  check(errors, "slowQueries", value.slowQueries, SLOW_QUERIES);
  check(errors, "dbWorker", value.dbWorker, DB_WORKER);
  check(errors, "scrapeActivity", value.scrapeActivity, SCRAPE_ACTIVITY);
  check(errors, "rateLimiter", value.rateLimiter, RATE_LIMITER);

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      errors.push(`${key}: unexpected top-level key`);
    }
  }
  // The backend tag and the backend-specific kinds must agree.
  if (value.backend === "node") {
    if (heapKind !== "v8") {
      errors.push(
        `heap.kind: a node backend reports "v8", got ${JSON.stringify(heapKind)}`
      );
    }
    if (schedKind !== "event-loop") {
      errors.push(
        `scheduler.kind: a node backend reports "event-loop", got ${JSON.stringify(schedKind)}`
      );
    }
  }
  if (value.backend === "rust") {
    if (heapKind !== "rust-allocator") {
      errors.push(
        `heap.kind: a rust backend reports "rust-allocator", got ${JSON.stringify(heapKind)}`
      );
    }
    if (schedKind !== "tokio") {
      errors.push(
        `scheduler.kind: a rust backend reports "tokio", got ${JSON.stringify(schedKind)}`
      );
    }
    if (value.dbWorker !== null) {
      errors.push(
        "dbWorker: a rust backend has no db-worker thread and reports null"
      );
    }
  }
  return errors;
}
