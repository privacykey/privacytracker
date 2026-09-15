//! Replay the actual Node GET responses, including fault-injected fallbacks.
use super::{routes_devices, AppState};
use axum::{
    body::to_bytes,
    extract::{Path, Query, State},
};
use rusqlite::Connection;
use serde_json::Value;
use std::sync::{Arc, Mutex};

fn apply(conn: &Connection, statements: &Value) {
    for s in statements.as_array().unwrap() {
        let params = s["params"]
            .as_array()
            .unwrap()
            .iter()
            .map(super::row::to_sql_value)
            .collect::<Vec<_>>();
        conn.execute(
            s["sql"].as_str().unwrap(),
            rusqlite::params_from_iter(params),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn device_gets_match_node_status_and_raw_bytes_without_writes() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/devices-cases.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let conn = crate::db::open_and_migrate(std::path::Path::new(":memory:")).unwrap();
        if case["empty"] != true {
            apply(&conn, &fixture["base"]);
        }
        apply(&conn, &case["changes"]);
        let changes = conn.total_changes();
        let state = AppState {
            conn: Arc::new(Mutex::new(conn)),
            rate_limiter: Arc::new(super::ratelimit::RateLimiter::new()),
            started_at: std::time::Instant::now(),
            bound_port: 0,
        };
        let id = Path(case["id"].as_str().unwrap().to_owned());
        let extract = State(state.clone());
        let response = match case["op"].as_str().unwrap() {
            "devices" => {
                routes_devices::devices(
                    extract,
                    Query(serde_json::from_value(case["query"].clone()).unwrap()),
                )
                .await
            }
            "detail" => routes_devices::detail(extract, id).await,
            "bundles" => routes_devices::bundles(extract, id).await,
            "tracked_apps" => routes_devices::tracked_apps(extract, id).await,
            "for_app" => routes_devices::for_app(extract, id).await,
            op => panic!("unknown operation: {op}"),
        };
        assert_eq!(
            response.status().as_u16() as u64,
            case["status"].as_u64().unwrap(),
            "{} status",
            case["name"]
        );
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            std::str::from_utf8(&body).unwrap(),
            case["body"].as_str().unwrap(),
            "{} body",
            case["name"]
        );
        assert_eq!(
            state.db().total_changes(),
            changes,
            "{} wrote to SQLite",
            case["name"]
        );
    }
}
