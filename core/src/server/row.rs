//! Turning SQLite column values into JSON the way better-sqlite3 does.
//!
//! Shared because one case is not obvious: a REAL column holding an integral
//! value. `serde_json` writes `1787843602839.0` where Node writes
//! `1787843602839`, and the parity differ's `~epoch` mask only covers numbers
//! below 4.1e12 — so it would see the difference on exactly the timestamps
//! this API returns.

use rusqlite::types::Value as SqlValue;
use rusqlite::Row;
use serde_json::Value;

use crate::jsnum::js_number;

/// What better-sqlite3 hands JavaScript for one column value.
///
/// The REAL/`js_number` case is the one that bites: serde would write
/// `1787843602839.0` for a float-typed timestamp where Node writes
/// `1787843602839`, and the parity differ's `~epoch` mask only covers values
/// below 4.1e12, so it would see the difference.
pub fn column_value(value: SqlValue) -> Value {
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(i) => Value::from(i),
        SqlValue::Real(f) => js_number(f),
        SqlValue::Text(s) => Value::from(s),
        // better-sqlite3 yields a Buffer, and `JSON.parse(buffer)` coerces it
        // via toString — so a BLOB that holds JSON text still parses in Node.
        // Decoding keeps that working. (A Buffer reaching JSON.stringify
        // directly would serialise as `{"type":"Buffer","data":[…]}`; no
        // column this server reads is declared BLOB, so that case is left.)
        SqlValue::Blob(b) => Value::from(String::from_utf8_lossy(&b).into_owned()),
    }
}

/// Read one named column, for the routes that do know their shape.
pub fn column(row: &Row<'_>, name: &str) -> rusqlite::Result<Value> {
    Ok(column_value(row.get::<_, SqlValue>(name)?))
}

/// Build a JSON object from every column of a row, in the order SQLite
/// reports them.
///
/// `/api/apps` needs this because its queries are `SELECT a.*, <six computed
/// counts>` and `getAppWithPrivacy` is `SELECT * FROM apps`. What `*` expands
/// to is the TABLE's column order, which is not a constant:
///
/// * on a fresh install it is the order of the `CREATE TABLE` body in
///   `lib/db.ts`;
/// * on an install that predates a column, it is the original `CREATE` order
///   with each `ALTER TABLE … ADD COLUMN` appended in migration order.
///
/// `lib/db.ts` deliberately lists those columns in BOTH places, so the two
/// layouts hold the same columns in a different ORDER — and `JSON.stringify`
/// replays whatever order the driver reported. A Rust struct would hard-code
/// one of them and diverge on the other. Both backends read the same file, so
/// taking the order from the statement at runtime is the only thing that
/// works on both.
///
/// `serde_json` is built with `preserve_order`, so its `Map` is an `IndexMap`
/// and insertion order survives to the wire. That also gives the right answer
/// for a DUPLICATE column name — `SELECT a.*, COUNT(*) AS name` yields two
/// `name` columns, and `IndexMap::insert` keeps the first position with the
/// last value, exactly as assigning twice to a JavaScript object property
/// does.
pub fn row_to_json(row: &Row<'_>) -> rusqlite::Result<Value> {
    let stmt = row.as_ref();
    let count = stmt.column_count();
    let mut map = serde_json::Map::with_capacity(count);
    for i in 0..count {
        let name = stmt.column_name(i)?.to_string();
        map.insert(name, column_value(row.get::<_, SqlValue>(i)?));
    }
    Ok(Value::Object(map))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("in-memory db");
        c.execute_batch(
            "CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, n INTEGER, f REAL, spare TEXT);
             INSERT INTO t VALUES ('a', 'Alpha', 7, 1.0, NULL);",
        )
        .expect("fixture");
        c
    }

    #[test]
    fn an_integral_real_serialises_without_a_decimal_point() {
        let c = conn();
        let json: Value = c
            .query_row("SELECT f FROM t", [], |row| column(row, "f"))
            .unwrap();
        // SQLite stores 1.0 as REAL; Node prints `1`, serde would print `1.0`.
        assert_eq!(serde_json::to_string(&json).unwrap(), "1");
    }

    #[test]
    fn keys_follow_the_statements_column_order_not_the_alphabet() {
        let c = conn();
        let mut stmt = c.prepare("SELECT * FROM t").unwrap();
        let json = stmt.query_row([], row_to_json).expect("row_to_json");
        assert_eq!(
            serde_json::to_string(&json).unwrap(),
            r#"{"id":"a","name":"Alpha","n":7,"f":1,"spare":null}"#
        );
    }

    #[test]
    fn a_column_added_later_appears_last_exactly_as_alter_table_puts_it() {
        let c = conn();
        c.execute_batch("ALTER TABLE t ADD COLUMN added_later TEXT DEFAULT 'x';")
            .unwrap();
        let mut stmt = c.prepare("SELECT * FROM t").unwrap();
        let json = stmt.query_row([], row_to_json).unwrap();
        let keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys.last(),
            Some(&"added_later"),
            "ALTER TABLE appends and `SELECT *` replays that — which is why this cannot be a struct"
        );
    }

    #[test]
    fn computed_columns_follow_the_table_columns() {
        let c = conn();
        let mut stmt = c
            .prepare("SELECT t.*, 0 AS categoryCount, 1 AS trackCount FROM t")
            .unwrap();
        let json = stmt.query_row([], row_to_json).unwrap();
        let keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "id",
                "name",
                "n",
                "f",
                "spare",
                "categoryCount",
                "trackCount"
            ]
        );
    }

    #[test]
    fn a_duplicate_column_name_keeps_the_first_slot_and_the_last_value() {
        let c = conn();
        let mut stmt = c.prepare("SELECT t.*, 'shadow' AS id FROM t").unwrap();
        let json = stmt.query_row([], row_to_json).unwrap();
        let obj = json.as_object().unwrap();
        assert_eq!(
            obj.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["id", "name", "n", "f", "spare"]
        );
        assert_eq!(obj["id"], Value::from("shadow"));
    }

    #[test]
    fn the_other_storage_classes_map_straight_across() {
        let c = conn();
        let get = |name: &'static str| {
            c.query_row("SELECT * FROM t", [], |row| column(row, name))
                .unwrap()
        };
        assert_eq!(get("id"), Value::from("a"));
        assert_eq!(get("n"), Value::from(7));
        assert_eq!(get("spare"), Value::Null);
    }
}
