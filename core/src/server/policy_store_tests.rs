//! Replays `core/tests/fixtures/policy-store-cases.json`.
//!
//! STORE cases run `sync_policy_fetch` against a database seeded with the
//! case's setup, with the recorded replies served to the REAL transport
//! loop over a canned hop. The clock ticks one second per hop the code
//! awaits; Save Page Now and the webhook POST — the two Node fires and
//! forgets — are free, and run after the sync from what it handed back,
//! into a separate `late` stream. Compared: every raw fetch, the write
//! stream, the late stream, eight tables and the return value.
//!
//! ROUTE cases call the handlers with the case's params and headers and
//! compare the wire response, the stream and the tables. JSON cases hold
//! `crate::jsjson` to V8's messages and `JSON.stringify(JSON.parse(s))`.
use super::policy_store::{
    run_follow_ups, sync_policy_analysis, Phase, PolicyRequest, SyncOptions,
};
use super::sync_runner::Clock;
use crate::{
    outbound::{fetch_via, FetchFuture, Fetcher, Hop, HopFuture, Outgoing, Request},
    scrape::{
        fetch_tests::raw_reply,
        persist::{Locked, Statement},
        persist_tests::{dump, to_sql, CountingIds},
    },
};
use reqwest::header::HeaderMap;
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use url::Url;

pub(super) const TABLES: [&str; 8] = [
    "privacy_policy_analyses",
    "privacy_policy_versions",
    "privacy_snapshots",
    "notifications",
    "activity_log",
    "manual_app_events",
    "manual_app_policy_versions",
    "audit_log",
];
const TICK: i64 = 1000;

extern "C" {
    fn tzset();
}

/// The oracle's environment, for as long as this lives, under the env
/// lock: `TZ=UTC` (quiet hours read local time) and a trusted proxy, so
/// the forwarded address keys the rate limits and names the audit actor.
pub(super) struct Utc {
    previous: Vec<(&'static str, Option<String>)>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl Utc {
    pub(super) fn new() -> Self {
        let lock = crate::server::trust::env_lock();
        let vars: [(&'static str, Option<&str>); 6] = [
            ("TZ", Some("UTC")),
            ("PRIVACYTRACKER_TRUST_PROXY", Some("1")),
            ("PRIVACYTRACKER_BIND_HOST", Some("127.0.0.1")),
            ("PRIVACYTRACKER_NETWORK_EXPOSED", None),
            ("PRIVACYTRACKER_RUNTIME", None),
            ("PRIVACYTRACKER_ALLOWED_HOSTS", None),
        ];
        let previous = vars
            .iter()
            .map(|(name, value)| {
                let before = std::env::var(name).ok();
                match value {
                    Some(v) => std::env::set_var(name, v),
                    None => std::env::remove_var(name),
                }
                (*name, before)
            })
            .collect();
        // SAFETY: tzset takes no pointers; the env lock serializes the edit.
        unsafe { tzset() };
        Self {
            previous,
            _lock: lock,
        }
    }
}

impl Drop for Utc {
    fn drop(&mut self) {
        for (name, before) in &self.previous {
            match before {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
        // SAFETY: as above; the lock is released after this runs.
        unsafe { tzset() };
    }
}

pub(super) fn fixture() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/policy-store-cases.json")).unwrap()
}

/// The oracle's clock: frozen, moved only by the canned hop.
pub(super) struct Ticking(pub(super) Arc<AtomicI64>);
impl Clock for Ticking {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub(super) struct Canned {
    replies: Vec<Value>,
    cursor: AtomicUsize,
    pub(super) calls: Mutex<Vec<Value>>,
    /// Node's stub recorded exactly the headers the caller set, so an
    /// explicit Accept-Encoding is kept and the transport's default is not.
    explicit_encoding: AtomicBool,
    clock: Arc<AtomicI64>,
}

impl Canned {
    pub(super) fn new(replies: Vec<Value>, clock: Arc<AtomicI64>) -> Self {
        Self {
            replies,
            cursor: AtomicUsize::new(0),
            calls: Mutex::new(vec![]),
            explicit_encoding: AtomicBool::new(false),
            clock,
        }
    }
    pub(super) fn unused(&self) -> usize {
        self.replies
            .len()
            .saturating_sub(self.cursor.load(Ordering::SeqCst))
    }
}

impl Hop for Canned {
    fn hop(&self, url: Url, headers: HeaderMap, outgoing: Outgoing) -> HopFuture<'_> {
        Box::pin(async move {
            let explicit = self.explicit_encoding.load(Ordering::SeqCst);
            let mut sent: Vec<(String, String)> = headers
                .iter()
                .filter(|(k, v)| {
                    !((k.as_str() == "accept-encoding" && !explicit)
                        || (k.as_str() == "accept" && v.as_bytes() == b"*/*"))
                })
                .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            sent.sort();
            let mut call = json!({"url": url.as_str(), "headers": sent});
            if outgoing.method != "GET" {
                call["method"] = json!(outgoing.method);
                call["body"] = outgoing
                    .body
                    .as_deref()
                    .map_or(Value::Null, |b| json!(String::from_utf8_lossy(b)));
            }
            self.calls.lock().unwrap().push(call);
            let free = url.as_str().starts_with("https://web.archive.org/save/")
                || outgoing.method != "GET";
            if !free {
                self.clock.fetch_add(TICK, Ordering::SeqCst);
            }
            let index = self.cursor.fetch_add(1, Ordering::SeqCst);
            let Some(reply) = self.replies.get(index) else {
                return Err(format!("Missing fixture reply for {url}"));
            };
            raw_reply(reply)
        })
    }
}

impl Fetcher for Canned {
    fn fetch(&self, request: Request) -> FetchFuture<'_> {
        self.explicit_encoding.store(
            request
                .headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("accept-encoding")),
            Ordering::SeqCst,
        );
        Box::pin(async move { fetch_via(self, request).await })
    }
}

pub(super) fn seeded(setup: &Value) -> Connection {
    let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
    for step in setup.as_array().unwrap() {
        let params: Vec<_> = step["params"]
            .as_array()
            .unwrap()
            .iter()
            .map(to_sql)
            .collect();
        conn.execute(step["sql"].as_str().unwrap(), params_from_iter(params))
            .unwrap_or_else(|e| panic!("setup {}: {e}", step["sql"]));
    }
    conn
}

pub(super) fn statements(stream: &[Statement]) -> Value {
    Value::Array(
        stream
            .iter()
            .map(|s| json!({"sql": s.sql, "params": s.params}))
            .collect(),
    )
}

pub(super) fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

pub(super) fn compare(wrong: &mut Vec<String>, what: &str, expected: &Value, actual: &Value) {
    if expected != actual {
        wrong.push(format!(
            "{what}\n  expected {expected}\n  actual   {actual}"
        ));
    }
}

#[test]
fn policy_store_matches_node_calls_streams_rows_and_result() {
    let _utc = Utc::new();
    let fixture = fixture();
    let cases: Vec<&Value> = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["kind"] == "store")
        .collect();
    assert!(cases.len() >= 34, "fixture has {} store cases", cases.len());
    let rt = runtime();
    let mut failures: Vec<String> = vec![];
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mutex = Mutex::new(seeded(&case["setup"]));
        let clock = Arc::new(AtomicI64::new(case["now"].as_i64().unwrap()));
        let ticking = Ticking(clock.clone());
        let fetcher = Canned::new(case["replies"].as_array().unwrap().clone(), clock.clone());
        let req = &case["request"];
        let request = PolicyRequest {
            app_id: req["appId"].as_str().unwrap().to_string(),
            app_name: req["appName"].as_str().unwrap().to_string(),
            developer: req["developer"].as_str().map(str::to_string),
            policy_url: req["policyUrl"].as_str().map(str::to_string),
        };
        let options = SyncOptions {
            phase: Phase::Fetch,
            force_resummarise: case["options"]["forceResummarise"] == true,
            bypass_throttle: case["options"]["bypassThrottle"] == true,
        };
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let mut stream = vec![];
        let outcome = {
            let mut db = Locked {
                conn: &mutex,
                log: Some(&mut stream),
                on_wait: None,
            };
            rt.block_on(sync_policy_analysis(
                &mut db, &mut ids, &fetcher, &ticking, &request, options,
            ))
        };
        let mut late = vec![];
        let expected = match outcome {
            Ok(synced) => {
                let mut db = Locked {
                    conn: &mutex,
                    log: Some(&mut late),
                    on_wait: None,
                };
                rt.block_on(run_follow_ups(
                    &mut db,
                    &fetcher,
                    &ticking,
                    synced.follow_ups,
                ));
                json!({"ok": true, "result": synced.analysis})
            }
            Err(error) => json!({"ok": false, "error": error}),
        };
        let mut wrong = vec![];
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
        compare(&mut wrong, "result", &case["expected"], &expected);
        if !wrong.is_empty() {
            failures.push(format!("{name}\n{}", wrong.join("\n")));
        }
    }
    assert!(
        failures.is_empty(),
        "{} policy-store parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

#[test]
fn json_parse_matches_v8() {
    let fixture = fixture();
    let mut failures: Vec<String> = vec![];
    for case in fixture["json"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let actual = match crate::jsjson::roundtrip(input) {
            Ok(stringified) => json!({"input": input, "ok": true, "stringified": stringified}),
            Err(error) => json!({"input": input, "ok": false, "error": error}),
        };
        if &actual != case {
            failures.push(format!("expected {case}\n  actual {actual}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} JSON.parse parity failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// The wire as the oracle recorded it: status, Content-Type, Retry-After
/// and the body text.
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
    let bytes = rt
        .block_on(axum::body::to_bytes(response.into_body(), usize::MAX))
        .unwrap();
    json!({
        "status": status,
        "type": kind,
        "retryAfter": retry_after,
        "body": String::from_utf8_lossy(&bytes),
    })
}

#[test]
fn policy_routes_match_node_wire_calls_stream_and_rows() {
    use super::{
        guard::Actor,
        ratelimit::RateLimiter,
        routes_policy,
        writes::{self, precheck},
    };
    use crate::scrape::persist::Writer;
    use axum::http::{HeaderMap, HeaderName, HeaderValue, Method};

    let _env = Utc::new();
    let fixture = fixture();
    let cases: Vec<&Value> = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["kind"] == "route")
        .collect();
    assert!(cases.len() >= 35, "fixture has {} route cases", cases.len());
    let rt = runtime();
    let mut failures: Vec<String> = vec![];
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let route = case["route"].as_str().unwrap();
        let params = &case["params"];
        let param = |key: &str| params[key].as_str().unwrap_or("").to_string();
        let now = case["now"].as_i64().unwrap();
        let mutex = Mutex::new(seeded(&case["setup"]));
        let clock = Arc::new(AtomicI64::new(now));
        let ticking = Ticking(clock.clone());
        let fetcher = Canned::new(case["replies"].as_array().unwrap().clone(), clock.clone());
        let mut headers = HeaderMap::new();
        for (k, v) in case["headers"].as_object().unwrap() {
            headers.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v.as_str().unwrap()).unwrap(),
            );
        }
        let limiter = RateLimiter::new();
        let mut ids = CountingIds {
            prefix: "00000000-0000-4000-8000-",
            next: 0,
        };
        let mut stream = vec![];
        let mut last = Value::Null;
        for _ in 0..case["repeat"].as_u64().unwrap() {
            let response = match route {
                "/api/policy/status/[appId]" => {
                    routes_policy::status_with(&mutex.lock().unwrap(), &param("appId"))
                }
                "/api/policy/version/[id]" => routes_policy::version_with(
                    &mutex.lock().unwrap(),
                    &limiter,
                    &headers,
                    &param("id"),
                    now,
                ),
                "/api/policy/version/[id]/diff" => routes_policy::diff_with(
                    &mutex.lock().unwrap(),
                    &limiter,
                    &headers,
                    &param("id"),
                    now,
                ),
                "/api/manual-apps/[id]/policy-version/[versionId]" => {
                    routes_policy::manual_version_with(
                        &mutex.lock().unwrap(),
                        &limiter,
                        &headers,
                        &param("id"),
                        &param("versionId"),
                        now,
                    )
                }
                "/api/manual-apps/[id]/scrape" => {
                    let spec = writes::lookup(route, &Method::POST).unwrap();
                    let id = param("id");
                    let guarded: Result<Actor, _> = {
                        let guard = mutex.lock().unwrap();
                        let mut w = Writer::new(&guard, Some(&mut stream));
                        precheck(&mut w, &mut ids, &limiter, &headers, spec, Some(&id), now)
                    };
                    match guarded {
                        Err(refused) => refused,
                        Ok(actor) => {
                            let mut db = Locked {
                                conn: &mutex,
                                log: Some(&mut stream),
                                on_wait: None,
                            };
                            rt.block_on(routes_policy::scrape_manual_app(
                                &mut db, &mut ids, &fetcher, &ticking, &id, &actor,
                            ))
                        }
                    }
                }
                other => panic!("{name}: no route {other}"),
            };
            last = wire(&rt, response);
        }
        let mut wrong = vec![];
        compare(&mut wrong, "wire", &case["expected"], &last);
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
        "{} policy-route parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
