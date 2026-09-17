//! Replays `core/tests/fixtures/wayback-runner-cases.json`: the three
//! routes and the boot-time resume, through an accessor the spawned runs
//! can detach, a shared id counter, and a fetcher that carries the case's
//! mid-run hooks — a PATCH issued at a given fetch, either inline (a
//! cancel then stalls the request, as an aborted one never returns) or a
//! moment later, during the runner's backoff sleep. Each fetch yields once
//! before answering, as Node's stub resolves on the next turn.
use super::{
    body::{read_json, BodyOutcome},
    guard::Actor,
    ratelimit::RateLimiter,
    sync_runner::{self, Fixed},
    wayback_runner,
    writes::{self, WriteRequest},
};
use crate::{
    outbound::{FetchFuture, Fetcher, Request},
    scrape::{
        fetch_tests::Canned,
        persist::{Ids, Shared, Statement},
        persist_tests::{dump, to_sql},
    },
};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderName, HeaderValue, Method},
};
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

/// The oracle's one counter, shared by the request and the run it spawns.
#[derive(Clone)]
struct SharedIds(Arc<Mutex<u64>>);

impl Ids for SharedIds {
    fn uuid(&mut self, _conn: &Connection) -> Result<String, String> {
        let mut n = self.0.lock().unwrap();
        *n += 1;
        Ok(format!("00000000-0000-4000-8000-{:012}", *n))
    }
    fn short_id(&mut self, _conn: &Connection, prefix: &str) -> Result<String, String> {
        let mut n = self.0.lock().unwrap();
        *n += 1;
        Ok(format!("{prefix}_{:012}", *n))
    }
    fn detach(&self) -> Option<Box<dyn Ids>> {
        Some(Box::new(self.clone()))
    }
}

struct Hook {
    at_call: usize,
    action: &'static str,
    after_ms: Option<u64>,
}

/// What a hook's PATCH needs: the case's connection, recording, ids,
/// limiter and headers.
struct PatchContext {
    conn: Arc<Mutex<Connection>>,
    log: Arc<Mutex<Vec<Statement>>>,
    ids: SharedIds,
    limiter: Arc<RateLimiter>,
    headers: HeaderMap,
    now: i64,
}

impl PatchContext {
    async fn patch(&self, action: &str) {
        let spec = writes::lookup("/api/wayback/import-all", &Method::PATCH).unwrap();
        let mut ids = self.ids.clone();
        let actor = {
            let guard = self.conn.lock().unwrap();
            let mut log = self.log.lock().unwrap();
            let mut w = crate::scrape::persist::Writer::new(&guard, Some(&mut log));
            match writes::precheck(
                &mut w,
                &mut ids,
                &self.limiter,
                &self.headers,
                spec,
                None,
                self.now,
            ) {
                Ok(actor) => actor,
                Err(_) => Actor {
                    ip: String::new(),
                    user_agent: None,
                },
            }
        };
        let body = read_json(
            &self.headers,
            Body::from(json!({ "action": action }).to_string()),
            4 * 1024,
        )
        .await;
        let mut db = Shared {
            conn: self.conn.clone(),
            log: Some(self.log.clone()),
            on_wait: None,
        };
        let _ = writes::perform_async(
            &mut db,
            &mut ids,
            &NoFetch,
            WriteRequest {
                spec,
                param: None,
                query: &[],
                body,
            },
            &actor,
            self.now,
        )
        .await;
    }
}

struct NoFetch;
impl Fetcher for NoFetch {
    fn fetch(&self, request: Request) -> FetchFuture<'_> {
        Box::pin(async move { Err(format!("unexpected fetch of {}", request.url)) })
    }
}

#[derive(Clone)]
struct Hooked {
    inner: Arc<Canned>,
    hooks: Arc<Vec<Hook>>,
    seen: Arc<AtomicUsize>,
    patch: Arc<PatchContext>,
}

impl Fetcher for Hooked {
    fn shared(&self) -> Option<Arc<dyn Fetcher>> {
        Some(Arc::new(self.clone()))
    }
    fn fetch(&self, request: Request) -> FetchFuture<'_> {
        Box::pin(async move {
            tokio::task::yield_now().await;
            let index = self.seen.fetch_add(1, Ordering::SeqCst);
            let hook = self.hooks.iter().find(|h| h.at_call == index);
            match hook {
                Some(hook) if hook.after_ms.is_some() => {
                    let patch = self.patch.clone();
                    let action = hook.action;
                    let after = hook.after_ms.unwrap();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(after)).await;
                        patch.patch(action).await;
                    });
                    self.inner.fetch(request).await
                }
                Some(hook) if hook.action == "cancel" => {
                    // Recorded like any call, then the control lands and
                    // the request never returns.
                    let _ = self.inner.fetch(request).await;
                    self.patch.patch("cancel").await;
                    std::future::pending::<()>().await;
                    unreachable!()
                }
                Some(hook) => {
                    self.patch.patch(hook.action).await;
                    self.inner.fetch(request).await
                }
                None => self.inner.fetch(request).await,
            }
        })
    }
}

fn settled(conn: &Arc<Mutex<Connection>>) -> bool {
    let guard = conn.lock().unwrap();
    super::settings::get_setting_with(&guard, "wayback_import_running", "").unwrap_or_default()
        != "true"
}

#[test]
fn wayback_runner_paths_match_node_wire_calls_stream_and_rows() {
    let _env = crate::server::trust::env_lock();
    std::env::set_var("PRIVACYTRACKER_TRUST_PROXY", "1");
    std::env::set_var("PRIVACYTRACKER_BIND_HOST", "127.0.0.1");
    for var in [
        "PRIVACYTRACKER_NETWORK_EXPOSED",
        "PRIVACYTRACKER_RUNTIME",
        "PRIVACYTRACKER_ALLOWED_HOSTS",
        "AUDITOR_ADMIN_TOKEN",
    ] {
        std::env::remove_var(var);
    }

    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/wayback-runner-cases.json"
    ))
    .unwrap();
    let now = fixture["now"].as_i64().unwrap();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut failures = vec![];
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
        let tables: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        conn.pragma_update(None, "foreign_keys", false).unwrap();
        for table in &tables {
            conn.execute(&format!("DELETE FROM \"{table}\""), [])
                .unwrap();
        }
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        for s in case["setup"].as_array().unwrap() {
            conn.execute(
                s["sql"].as_str().unwrap(),
                params_from_iter(s["params"].as_array().unwrap().iter().map(to_sql)),
            )
            .unwrap();
        }
        crate::scrape::ratelimit::reset_soft_buckets();
        let conn = Arc::new(Mutex::new(conn));
        let log: Arc<Mutex<Vec<Statement>>> = Arc::new(Mutex::new(vec![]));
        let ids = SharedIds(Arc::new(Mutex::new(0)));
        let limiter = Arc::new(RateLimiter::new());
        let mut headers = HeaderMap::new();
        for (k, v) in case["headers"].as_object().unwrap() {
            headers.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v.as_str().unwrap()).unwrap(),
            );
        }
        let hooks: Vec<Hook> = case["hooks"]
            .as_array()
            .map(|hs| {
                hs.iter()
                    .map(|h| Hook {
                        at_call: h["atCall"].as_u64().unwrap() as usize,
                        action: match h["action"].as_str().unwrap() {
                            "cancel" => "cancel",
                            "pause" => "pause",
                            other => panic!("{name}: unknown hook {other}"),
                        },
                        after_ms: h["afterMs"].as_u64(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let canned = Arc::new(Canned::new(
            case["replies"].as_array().unwrap().clone(),
            |_| {},
        ));
        let fetcher = Hooked {
            inner: canned.clone(),
            hooks: Arc::new(hooks),
            seen: Arc::new(AtomicUsize::new(0)),
            patch: Arc::new(PatchContext {
                conn: conn.clone(),
                log: log.clone(),
                ids: ids.clone(),
                limiter: limiter.clone(),
                headers: headers.clone(),
                now,
            }),
        };
        let mut db = Shared {
            conn: conn.clone(),
            log: Some(log.clone()),
            on_wait: None,
        };
        let mut ids_for_case = ids.clone();
        let mut wire = None;
        let wait = |rt: &tokio::runtime::Runtime| {
            rt.block_on(async {
                for _ in 0..3000 {
                    if settled(&conn) {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                panic!("{name}: the spawned run never settled");
            })
        };
        match case["kind"].as_str().unwrap() {
            "callback" => {
                let clock = Fixed(now);
                rt.block_on(wayback_runner::resume_wayback_import(
                    &mut db,
                    &fetcher,
                    &mut ids_for_case,
                    &clock,
                ))
                .unwrap();
                wait(&rt);
            }
            _ => {
                let method: Method = case["method"].as_str().unwrap().parse().unwrap();
                let spec = writes::lookup(case["route"].as_str().unwrap(), &method)
                    .unwrap_or_else(|| panic!("{name}: no route"));
                let query: Vec<(String, String)> = case["query"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|pair| {
                        (
                            pair[0].as_str().unwrap().to_string(),
                            pair[1].as_str().unwrap().to_string(),
                        )
                    })
                    .collect();
                let raw_body = case["body"].as_str().map(str::to_string);
                let mut response = None;
                for _ in 0..case["repeat"].as_u64().unwrap_or(1) {
                    let actor = {
                        let guard = conn.lock().unwrap();
                        let mut log = log.lock().unwrap();
                        let mut w = crate::scrape::persist::Writer::new(&guard, Some(&mut log));
                        match writes::precheck(
                            &mut w,
                            &mut ids_for_case,
                            &limiter,
                            &headers,
                            spec,
                            None,
                            now,
                        ) {
                            Ok(actor) => actor,
                            Err(refused) => {
                                response = Some(refused);
                                continue;
                            }
                        }
                    };
                    let body = match spec.body_limit {
                        Some(limit) => {
                            let body = raw_body
                                .as_ref()
                                .map_or_else(Body::empty, |b| Body::from(b.clone()));
                            rt.block_on(read_json(&headers, body, limit))
                        }
                        None => BodyOutcome::Empty,
                    };
                    response = Some(rt.block_on(writes::perform_async(
                        &mut db,
                        &mut ids_for_case,
                        &fetcher,
                        WriteRequest {
                            spec,
                            param: None,
                            query: &query,
                            body,
                        },
                        &actor,
                        now,
                    )));
                }
                let response = response.expect("at least one request");
                let status = response.status().as_u16();
                let header = |name: &str| {
                    response
                        .headers()
                        .get(name)
                        .map(|v| v.to_str().unwrap().to_string())
                };
                let content_type = header("content-type");
                let retry_after = header("retry-after");
                // Reading a streamed body drives the spawned run to its end.
                let body = rt.block_on(async {
                    String::from_utf8(
                        axum::body::to_bytes(response.into_body(), usize::MAX)
                            .await
                            .unwrap()
                            .to_vec(),
                    )
                    .unwrap()
                });
                if case["awaitRun"] == json!(true) {
                    wait(&rt);
                }
                wire = Some(json!({
                    "status": status, "body": body, "type": content_type, "retryAfter": retry_after
                }));
            }
        }
        // The case's own handles go first; a spawned run's — or a delayed
        // hook's — are gone once it has finished, so wait for them, and
        // what remains is the one the dump needs.
        drop(db);
        drop(fetcher);
        rt.block_on(async {
            for _ in 0..600 {
                if Arc::strong_count(&conn) == 1 {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        let conn = Arc::try_unwrap(conn)
            .unwrap_or_else(|_| panic!("{name}: a run still holds the connection"))
            .into_inner()
            .unwrap();
        let expected = &case["expected"];
        let expected_wire = if expected.is_null() {
            None
        } else {
            Some(json!({
                "status": expected["status"], "body": expected["body"], "type": expected["type"],
                "retryAfter": expected["retryAfter"],
            }))
        };
        let stream_json = Value::Array(
            log.lock()
                .unwrap()
                .iter()
                .map(|s| json!({"sql": s.sql, "params": s.params}))
                .collect(),
        );
        let calls = Value::Array(canned.calls.lock().unwrap().clone());
        let table_names: Vec<&str> = case["rows"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let rows = dump(&conn, &table_names);
        let mut diffs = vec![];
        if wire != expected_wire {
            diffs.push(format!(
                "wire\n  expected {expected_wire:?}\n  actual   {wire:?}"
            ));
        }
        if calls != case["calls"] {
            diffs.push(format!(
                "calls\n  expected {}\n  actual   {calls}",
                case["calls"]
            ));
        }
        if stream_json != case["stream"] {
            diffs.push(format!(
                "stream\n  expected {}\n  actual   {stream_json}",
                case["stream"]
            ));
        }
        if rows != case["rows"] {
            diffs.push(format!(
                "rows\n  expected {}\n  actual   {rows}",
                case["rows"]
            ));
        }
        if !diffs.is_empty() {
            failures.push(format!("{name}\n{}", diffs.join("\n")));
        }
        let _ = sync_runner::Live;
    }
    std::env::remove_var("PRIVACYTRACKER_TRUST_PROXY");
    std::env::remove_var("PRIVACYTRACKER_BIND_HOST");
    assert!(
        failures.is_empty(),
        "{} wayback runner parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
