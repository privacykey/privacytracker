//! Replays `core/tests/fixtures/policy-runner-cases.json`.
//!
//! ROUTE cases run `POST /api/policy/sync-all` as the axum wrapper runs
//! it: the limit through `precheck`, the body read under the route's cap,
//! then the handler, with a streamed run going in place (a replay's
//! accessor cannot be detached) and its frames as the body. RUNNER cases
//! call `run_bulk_policy_sync` as the deferred post-update fetch does,
//! collecting its frames. RESUME cases run the 12 s boot check. The
//! recorded replies go through the REAL transport, the clock ticking as
//! each awaited request is answered, and what each app's run fired and
//! forgot (Save Page Now) is finished after the run, into the `late`
//! stream, where Node's held replies land. Compared: the response or the
//! result, the frames, every raw fetch, the write stream, the late stream
//! and nine tables.
use super::{
    body::read_json,
    policy_runner::{resume_policy_sync, run_bulk_policy_sync, RunOptions},
    policy_store::{run_follow_ups, FollowUps},
    policy_store_tests::{compare, runtime, seeded, statements, Ticking, Utc},
    policy_summary_tests::Canned,
    ratelimit::RateLimiter,
    runner_writes::policy_sync_all,
    sync_runner::Clock,
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
    "apps",
    "privacy_policy_analyses",
    "privacy_policy_versions",
    "privacy_snapshots",
    "notifications",
    "activity_log",
    "ai_debug_log",
    "audit_log",
    "app_settings",
];

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/policy-runner-cases.json"
    ))
    .unwrap()
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

fn initiator(options: &Value) -> &'static str {
    match options["initiator"].as_str() {
        Some("manual") => "manual",
        Some("resume") => "resume",
        _ => "automatic",
    }
}

#[test]
fn policy_runner_matches_node_wire_frames_calls_stream_and_rows() {
    let _env = Utc::new();
    let fixture = fixture();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 30, "fixture has {} cases", cases.len());
    let rt = runtime();
    let mut failures: Vec<String> = vec![];
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mutex = Mutex::new(seeded(&case["setup"]));
        let clock = Arc::new(AtomicI64::new(case["now"].as_i64().unwrap()));
        let ticking: Arc<dyn Clock> = Arc::new(Ticking(clock.clone()));
        let fetcher = Canned::new(case["replies"].as_array().unwrap().clone(), clock.clone());
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let mut stream = vec![];
        let mut late = vec![];
        let mut follow_ups: Vec<FollowUps> = vec![];
        let mut actual = Value::Null;
        let mut frames = vec![];
        match case["kind"].as_str().unwrap() {
            "route" => {
                let mut headers = HeaderMap::new();
                for (k, v) in case["headers"].as_object().unwrap() {
                    headers.insert(
                        HeaderName::from_bytes(k.as_bytes()).unwrap(),
                        HeaderValue::from_str(v.as_str().unwrap()).unwrap(),
                    );
                }
                let spec = writes::lookup("/api/policy/sync-all", &Method::POST).unwrap();
                let limiter = RateLimiter::new();
                for _ in 0..case["repeat"].as_u64().unwrap() {
                    let now = clock.load(Ordering::SeqCst);
                    let guarded = {
                        let guard = mutex.lock().unwrap();
                        let mut w = Writer::new(&guard, Some(&mut stream));
                        precheck(&mut w, &mut ids, &limiter, &headers, spec, None, now)
                    };
                    let response = match guarded {
                        Err(refused) => refused,
                        Ok(actor) => {
                            let body = case["body"]
                                .as_str()
                                .map_or_else(Body::empty, |b| Body::from(b.to_string()));
                            let outcome =
                                rt.block_on(read_json(&headers, body, spec.body_limit.unwrap()));
                            let mut db = Locked {
                                conn: &mutex,
                                log: Some(&mut stream),
                                on_wait: None,
                            };
                            let (response, left) = rt.block_on(policy_sync_all(
                                &mut db,
                                &mut ids,
                                &fetcher,
                                ticking.clone(),
                                outcome,
                                &actor,
                            ));
                            follow_ups.extend(left);
                            response
                        }
                    };
                    actual = wire(&rt, response);
                }
            }
            "runner" => {
                let options = &case["options"];
                let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
                let mut db = Locked {
                    conn: &mutex,
                    log: Some(&mut stream),
                    on_wait: None,
                };
                let ran = rt.block_on(run_bulk_policy_sync(
                    &mut db,
                    &fetcher,
                    &mut ids,
                    ticking.as_ref(),
                    RunOptions {
                        initiator: initiator(options),
                        phase: if options["phase"] == "all" {
                            "all"
                        } else {
                            "fetch"
                        },
                        force: options["force"] == true,
                        resume_state: options.get("resumeState").cloned(),
                        stream_requested: false,
                        writer: Some(tx),
                        actor_ip: options["actorIp"].as_str().map(str::to_string),
                        user_agent: options["userAgent"].as_str().map(str::to_string),
                    },
                ));
                while let Ok(frame) = rx.try_recv() {
                    frames.push(frame);
                }
                actual = match ran.outcome {
                    Ok(result) => json!({
                        "ok": true,
                        "result": { "totals": result.totals, "durationMs": result.duration_ms },
                    }),
                    Err(error) => json!({ "ok": false, "error": error }),
                };
                follow_ups.extend(ran.follow_ups);
            }
            _ => {
                let mut db = Locked {
                    conn: &mutex,
                    log: Some(&mut stream),
                    on_wait: None,
                };
                follow_ups.extend(rt.block_on(resume_policy_sync(
                    &mut db,
                    &fetcher,
                    &mut ids,
                    ticking.as_ref(),
                )));
            }
        }
        {
            let mut db = Locked {
                conn: &mutex,
                log: Some(&mut late),
                on_wait: None,
            };
            for left in follow_ups {
                rt.block_on(run_follow_ups(&mut db, &fetcher, ticking.as_ref(), left));
            }
        }
        let mut expected = case["expected"].clone();
        if let Some(obj) = expected.as_object_mut() {
            // A throw is Next's bare 500; the message is Node's alone.
            obj.remove("thrown");
        }
        let mut wrong = vec![];
        compare(&mut wrong, "expected", &expected, &actual);
        compare(&mut wrong, "frames", &case["frames"], &Value::Array(frames));
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
        "{} policy-runner parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
