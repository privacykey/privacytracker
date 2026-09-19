//! Replays `core/tests/fixtures/ai-routes-cases.json`.
//!
//! Each case runs as the axum wrapper runs it: the guard through
//! `precheck`, the body read under the route's cap, then `respond`, against
//! a database seeded with the case's setup and with the recorded replies
//! served through the REAL transport, the clock ticking as each awaited
//! request is answered. What the regenerate run fired and forgot (Save
//! Page Now) is finished after the response, into the `late` stream, as
//! Node's held reply lands after the route returns. A streamed regenerate
//! runs in place here, because a replay's accessor cannot be detached, and
//! its lines are the body. Compared: the response on the wire, every raw
//! fetch, the write stream, the late stream and nine tables.
use super::{
    body::read_json,
    policy_store::{run_follow_ups, FollowUps},
    policy_store_tests::{compare, runtime, seeded, statements, Ticking, Utc},
    policy_summary_tests::Canned,
    ratelimit::RateLimiter,
    routes_ai,
    writes::{self, precheck},
};
use crate::scrape::{
    persist::{Locked, Writer},
    persist_tests::{dump, CountingIds},
};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderName, HeaderValue, Method},
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc, Mutex,
};

const TABLES: [&str; 9] = [
    "privacy_policy_analyses",
    "privacy_policy_versions",
    "privacy_snapshots",
    "notifications",
    "activity_log",
    "ai_debug_log",
    "app_settings",
    "audit_log",
    "apps",
];

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/ai-routes-cases.json")).unwrap()
}

/// The response as the oracle recorded it.
fn wire(rt: &tokio::runtime::Runtime, response: axum::response::Response) -> Value {
    let status = response.status().as_u16();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map_or(Value::Null, |v| json!(v))
    };
    let kind = header("content-type");
    let retry_after = header("retry-after");
    let cache_control = header("cache-control");
    let bytes = rt
        .block_on(axum::body::to_bytes(response.into_body(), usize::MAX))
        .unwrap();
    json!({
        "status": status,
        "type": kind,
        "retryAfter": retry_after,
        "cacheControl": cache_control,
        "body": String::from_utf8_lossy(&bytes),
    })
}

#[test]
fn ai_routes_match_node_wire_calls_stream_and_rows() {
    let _env = Utc::new();
    let fixture = fixture();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 120, "fixture has {} cases", cases.len());
    let rt = runtime();
    let mut failures: Vec<String> = vec![];
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let route = case["route"].as_str().unwrap();
        match case["adminToken"].as_str() {
            Some(token) => std::env::set_var("AUDITOR_ADMIN_TOKEN", token),
            None => std::env::remove_var("AUDITOR_ADMIN_TOKEN"),
        }
        let mutex = Mutex::new(seeded(&case["setup"]));
        let clock = Arc::new(AtomicI64::new(case["now"].as_i64().unwrap()));
        let fetcher = Canned::new(case["replies"].as_array().unwrap().clone(), clock.clone());
        let mut headers = HeaderMap::new();
        for (k, v) in case["headers"].as_object().unwrap() {
            headers.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v.as_str().unwrap()).unwrap(),
            );
        }
        let spec = writes::lookup(route, &Method::POST)
            .unwrap_or_else(|| panic!("{name}: no route {route}"));
        let limiter = RateLimiter::new();
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let mut stream = vec![];
        let mut late = vec![];
        let mut last = Value::Null;
        for _ in 0..case["repeat"].as_u64().unwrap() {
            let now = clock.load(Ordering::SeqCst);
            let guarded = {
                let guard = mutex.lock().unwrap();
                let mut w = Writer::new(&guard, Some(&mut stream));
                precheck(&mut w, &mut ids, &limiter, &headers, spec, None, now)
            };
            let (response, follow_ups) = match guarded {
                Err(refused) => (refused, FollowUps::default()),
                Ok(actor) => {
                    let body = case["body"]
                        .as_str()
                        .map_or_else(Body::empty, |b| Body::from(b.to_string()));
                    let outcome = rt.block_on(read_json(&headers, body, spec.body_limit.unwrap()));
                    let mut db = Locked {
                        conn: &mutex,
                        log: Some(&mut stream),
                        on_wait: None,
                    };
                    rt.block_on(routes_ai::respond(
                        &mut db,
                        &mut ids,
                        &fetcher,
                        Arc::new(Ticking(clock.clone())),
                        route,
                        outcome,
                        &actor,
                    ))
                }
            };
            last = wire(&rt, response);
            let mut db = Locked {
                conn: &mutex,
                log: Some(&mut late),
                on_wait: None,
            };
            rt.block_on(run_follow_ups(
                &mut db,
                &fetcher,
                &Ticking(clock.clone()),
                follow_ups,
            ));
        }
        // A throw is Next's bare 500; the message is Node's alone.
        let mut expected = case["expected"].clone();
        expected.as_object_mut().unwrap().remove("thrown");
        let mut wrong = vec![];
        compare(&mut wrong, "wire", &expected, &last);
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
    std::env::remove_var("AUDITOR_ADMIN_TOKEN");
    assert!(
        failures.is_empty(),
        "{} AI-route parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
