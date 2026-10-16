/**
 * Work that can write user data after an await. Restore is synchronous, so
 * checking this registry immediately before its transaction excludes every
 * registered writer until it settles. Keep it on globalThis so Next's route
 * and instrumentation chunks share it; a process restart clears stale work.
 */
const work: Set<symbol> = ((globalThis as any).__pt_database_work ??=
  new Set());

export async function withDatabaseWork<T>(body: () => Promise<T>): Promise<T> {
  const entry = Symbol("database work");
  work.add(entry);
  try {
    return await body();
  } finally {
    work.delete(entry);
  }
}

export function isDatabaseWorkLive(): boolean {
  return work.size > 0;
}
