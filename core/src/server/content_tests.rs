//! Fixed-clock expectations come from executing the actual Next handlers.
use super::{
    routes_content,
    row::to_sql_value,
    stats::{query, text},
};
use rusqlite::Connection;
use serde_json::Value;
#[tokio::test]
async fn seven_content_handlers_match_node_wire_and_cleanup() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/content-cases.json")).unwrap();
    let mut failures = Vec::new();
    for case in fixture["cases"].as_array().unwrap() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema_sql::SCHEMA_SQL).unwrap();
        conn.pragma_update(None, "foreign_keys", false).unwrap();
        let setup = if case["empty"] == true {
            vec![]
        } else {
            fixture["base"].as_array().unwrap().clone()
        };
        for s in setup.iter().chain(case["changes"].as_array().unwrap()) {
            conn.execute(
                text(&s["sql"]),
                rusqlite::params_from_iter(
                    s["params"].as_array().unwrap().iter().map(to_sql_value),
                ),
            )
            .unwrap();
        }
        let q = serde_json::from_value(case["query"].clone()).unwrap();
        let response = routes_content::read(
            &conn,
            text(&case["route"]),
            &q,
            fixture["now"].as_i64().unwrap(),
        );
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .map(|v| v.to_str().unwrap().to_owned());
        let disposition = response
            .headers()
            .get("content-disposition")
            .map(|v| v.to_str().unwrap().to_owned());
        let body = String::from_utf8(
            axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        let expected = &case["expected"];
        let notes = query(&conn, "SELECT id FROM annotations ORDER BY id", &[])
            .ok()
            .map(|rows| {
                rows.into_iter()
                    .map(|r| r["id"].clone())
                    .collect::<Vec<_>>()
            });
        if serde_json::json!({"status":status,"body":body,"type":content_type,"disposition":disposition})
            != *expected
            || serde_json::json!(notes) != case["survivingNotes"]
        {
            failures.push(format!("{}\nexpected: {}\nactual: {} {} type={:?}, disposition={:?}\nnotes: {:?} expected {}",case["name"],expected,status,body,content_type,disposition,notes,case["survivingNotes"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
