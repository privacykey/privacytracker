/**
 * The single normalized schema dumper used by schema-parity.mjs for BOTH
 * sides of the comparison. Only the migrator differs between Rust and
 * TypeScript; the dump is produced by this one function so the differ can
 * never introduce skew of its own.
 *
 * The normal form is deliberately logical, not textual: SQLite's
 * `sqlite_master.sql` for a table differs between a fresh install (one big
 * CREATE with all columns) and an upgraded one (old CREATE + appended
 * columns from ALTER), even though the resulting tables are identical. So we
 * compare what actually governs behaviour — the column set (name, type,
 * notnull, default, pk position), every index and its columns, and every
 * foreign key — all order-normalised. The raw `sql` is captured too, for a
 * secondary, advisory comparison.
 */
import BetterSqlite3 from "better-sqlite3";

/** Dump the full logical schema of the SQLite file at `path`. */
export function dumpSchema(path) {
  const db = new BetterSqlite3(path, { readonly: true });
  try {
    const sqliteVersion =
      db.pragma("user_version", { simple: true }) == null
        ? "unknown"
        : db.prepare("SELECT sqlite_version() AS v").get().v;

    const tables = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all();

    const schema = {};
    for (const { name, sql } of tables) {
      const columns = db
        .prepare(`PRAGMA table_info(${quote(name)})`)
        .all()
        .map((c) => ({
          name: c.name,
          type: c.type,
          notnull: c.notnull,
          dflt_value: c.dflt_value,
          pk: c.pk,
        }));

      // Indexes on this table: the ones SQLite auto-creates for UNIQUE/PK
      // (origin 'u'/'pk') AND the explicit CREATE INDEX ones (origin 'c').
      const indexes = db
        .prepare(`PRAGMA index_list(${quote(name)})`)
        .all()
        .map((idx) => ({
          name: idx.name,
          unique: idx.unique,
          origin: idx.origin,
          partial: idx.partial,
          columns: db
            .prepare(`PRAGMA index_info(${quote(idx.name)})`)
            .all()
            .map((c) => ({ seqno: c.seqno, cid: c.cid, name: c.name })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const foreignKeys = db
        .prepare(`PRAGMA foreign_key_list(${quote(name)})`)
        .all()
        .map((fk) => ({
          table: fk.table,
          from: fk.from,
          to: fk.to,
          on_update: fk.on_update,
          on_delete: fk.on_delete,
          match: fk.match,
        }))
        // FK ordering isn't meaningful; sort for a stable comparison.
        .sort((a, b) =>
          `${a.from}->${a.table}.${a.to}`.localeCompare(
            `${b.from}->${b.table}.${b.to}`
          )
        );

      schema[name] = { columns, indexes, foreignKeys, sql };
    }

    // Explicit CREATE INDEX objects, keyed by name — a second view that also
    // catches a WHERE clause or expression an index_list row abbreviates.
    const indexSql = {};
    for (const row of db
      .prepare(
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name"
      )
      .all()) {
      indexSql[row.name] = { table: row.tbl_name, sql: row.sql };
    }

    return {
      sqliteVersion,
      tableCount: tables.length,
      tables: schema,
      indexSql,
    };
  } finally {
    db.close();
  }
}

// PRAGMA doesn't accept bound parameters; table names here come only from
// sqlite_master (our own schema), never user input. Quote defensively anyway.
function quote(ident) {
  return `"${ident.replace(/"/g, '""')}"`;
}
