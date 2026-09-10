/**
 * TypeScript-side migrator for the schema-parity harness.
 *
 * Importing `lib/db` runs its module side effects: open
 * `<PRIVACYTRACKER_DATA_DIR>/privacy.db`, set the pragmas, run the schema
 * block, apply the guarded ALTER migrations, and run the data backfills —
 * i.e. exactly what a real server boot does. We then checkpoint and close so
 * the dumper (a separate connection) reads a settled main database file.
 *
 * Run by schema-parity.mjs as: npx tsx scripts/parity/ts-migrate.ts
 * with PRIVACYTRACKER_DATA_DIR pointed at the per-case directory. Uses
 * require (not top-level await) so tsx's CJS transform accepts it.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const db = require("../../lib/db").default;
try {
  db.pragma("wal_checkpoint(TRUNCATE)");
} catch {
  // best-effort settle
}
db.close();
