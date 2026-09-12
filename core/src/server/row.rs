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
