//! Replays `core/tests/fixtures/policy-triggers-cases.json`.
//!
//! Each case is a list of steps. A ROUTE step runs as the axum wrapper
//! runs it — the guard through `precheck`, the body read under the route's
//! cap, then `perform_async` — so the scrape, the import completion, the
//! sync trigger and the seed reach the policy step and the deferred queue
//! through their real call sites. A DRAIN step runs the queue now, as the
//! oracle's `__drainForTests` does; an SQL step changes the database
//! between steps, unrecorded. The recorded replies go through the REAL
//! transport, the clock frozen as the oracle's is, and everything the
//! policy runs fired and forgot (Save Page Now) is finished after the
//! last step, into the `late` stream. Compared: each response, every raw
//! fetch, the write stream, the late stream and nine tables.
use super::{
    body::{read_json, BodyOutcome},
    policy_store::run_follow_ups,
    policy_store_tests::{compare, runtime, seeded, statements, Utc},
    policy_summary_tests::Canned,
    policy_triggers::{self, FollowUps},
    ratelimit::RateLimiter,
    sync_runner::Fixed,
    writes::{self, precheck, WriteRequest},
};
use crate::scrape::{
    persist::{Locked, Writer},
    persist_tests::{dump, to_sql, CountingIds},
};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderName, HeaderValue, Method},
};
use rusqlite::params_from_iter;
use serde_json::{json, Value};
use std::sync::{atomic::AtomicI64, Arc, Mutex};

const TABLES: [&str; 9] = [
    "apps",
    "privacy_policy_analyses",
    "privacy_policy_versions",
    "privacy_snapshots",
    "notifications",
    "activity_log",
    "audit_log",
    "imports",
    "app_settings",
];

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/policy-triggers-cases.json"
    ))
    .unwrap()
}

/// The response as the oracle recorded it.
fn wire(rt: &tokio::runtime::Runtime, response: axum::response::Response) -> Value {
    let status = response.status().as_u16();
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map_or(Value::Null, |v| json!(v));
    let bytes = rt
        .block_on(axum::body::to_bytes(response.into_body(), usize::MAX))
        .unwrap();
    json!({ "status": status, "type": kind, "body": String::from_utf8_lossy(&bytes) })
}

#[test]
fn policy_triggers_match_node_wire_calls_stream_and_rows() {
    let _env = Utc::new();
    let fixture = fixture();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 19, "fixture has {} cases", cases.len());
    let rt = runtime();
    let mut failures: Vec<String> = vec![];
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let now = case["now"].as_i64().unwrap();
        policy_triggers::reset_for_tests();
        let mutex = Mutex::new(seeded(&case["setup"]));
        // The oracle's clock never moves; the canned hop's own tick is
        // read by nothing here.
        let fetcher = Canned::new(
            case["replies"].as_array().unwrap().clone(),
            Arc::new(AtomicI64::new(now)),
        );
        let limiter = RateLimiter::new();
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let mut stream = vec![];
        let mut late = vec![];
        let mut wires = vec![];
        let mut follow_ups: Vec<FollowUps> = vec![];
        for step in case["steps"].as_array().unwrap() {
            if let Some(statements) = step["sql"].as_array() {
                let conn = mutex.lock().unwrap();
                for s in statements {
                    let params: Vec<_> =
                        s["params"].as_array().unwrap().iter().map(to_sql).collect();
                    conn.execute(s["sql"].as_str().unwrap(), params_from_iter(params))
                        .unwrap();
                }
                continue;
            }
            if step["drain"] == true {
                let mut db = Locked {
                    conn: &mutex,
                    log: Some(&mut stream),
                    on_wait: None,
                };
                let drained = rt.block_on(policy_triggers::drain(
                    &mut db,
                    &fetcher,
                    &mut ids,
                    &Fixed(now),
                ));
                follow_ups.extend(drained.follow_ups);
                continue;
            }
            let token = step["adminToken"].as_str();
            match token {
                Some(t) => std::env::set_var("AUDITOR_ADMIN_TOKEN", t),
                None => std::env::remove_var("AUDITOR_ADMIN_TOKEN"),
            }
            let mut headers = HeaderMap::new();
            for (k, v) in case["headers"].as_object().unwrap() {
                headers.insert(
                    HeaderName::from_bytes(k.as_bytes()).unwrap(),
                    HeaderValue::from_str(v.as_str().unwrap()).unwrap(),
                );
            }
            if let Some(t) = token {
                headers.insert("x-auditor-admin-token", HeaderValue::from_str(t).unwrap());
            }
            let route = step["route"].as_str().unwrap();
            let spec = writes::lookup(route, &Method::POST)
                .unwrap_or_else(|| panic!("{name}: no route {route}"));
            let query: Vec<(String, String)> = url::form_urlencoded::parse(
                step["search"]
                    .as_str()
                    .unwrap_or("")
                    .trim_start_matches('?')
                    .as_bytes(),
            )
            .into_owned()
            .collect();
            let guarded = {
                let guard = mutex.lock().unwrap();
                let mut w = Writer::new(&guard, Some(&mut stream));
                precheck(&mut w, &mut ids, &limiter, &headers, spec, None, now)
            };
            let response = match guarded {
                Err(refused) => refused,
                Ok(actor) => {
                    let outcome = match spec.body_limit {
                        Some(limit) => {
                            let body = if step["json"].is_null() {
                                Body::empty()
                            } else {
                                Body::from(step["json"].to_string())
                            };
                            rt.block_on(read_json(&headers, body, limit))
                        }
                        None => BodyOutcome::Empty,
                    };
                    let mut db = Locked {
                        conn: &mutex,
                        log: Some(&mut stream),
                        on_wait: None,
                    };
                    rt.block_on(writes::perform_async(
                        &mut db,
                        &mut ids,
                        &fetcher,
                        WriteRequest {
                            spec,
                            param: None,
                            query: &query,
                            body: outcome,
                            headers: &headers,
                            state: None,
                        },
                        &actor,
                        now,
                    ))
                }
            };
            wires.push(wire(&rt, response));
            follow_ups.extend(policy_triggers::take_late());
        }
        {
            let mut db = Locked {
                conn: &mutex,
                log: Some(&mut late),
                on_wait: None,
            };
            for left in follow_ups {
                rt.block_on(run_follow_ups(&mut db, &fetcher, &Fixed(now), left));
            }
        }
        std::env::remove_var("AUDITOR_ADMIN_TOKEN");
        let expected_wires = Value::Array(
            case["wires"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| {
                    let mut w = w.clone();
                    // A throw is Next's bare 500; the message is Node's alone.
                    w.as_object_mut().unwrap().remove("thrown");
                    w
                })
                .collect(),
        );
        let mut wrong = vec![];
        compare(&mut wrong, "wires", &expected_wires, &Value::Array(wires));
        compare(
            &mut wrong,
            "calls",
            &case["calls"],
            &Value::Array(fetcher.calls.lock().unwrap().clone()),
        );
        if fetcher.unused() != 0 {
            wrong.push(format!("{} replies unused", fetcher.unused()));
        }
        compare(&mut wrong, "stream", &case["stream"], &statements(&stream));
        compare(&mut wrong, "late", &case["late"], &statements(&late));
        compare(
            &mut wrong,
            "rows",
            &case["rows"],
            &dump(&mutex.lock().unwrap(), &TABLES),
        );
        if !wrong.is_empty() {
            failures.push(format!("{name}\n{}", wrong.join("\n")));
        }
    }
    assert!(
        failures.is_empty(),
        "{} policy-trigger parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
