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
    fn hex_id(&mut self, _conn: &Connection, prefix: &str, bytes: usize) -> Result<String, String> {
        let mut n = self.0.lock().unwrap();
        *n += 1;
        Ok(format!("{prefix}{:0width$}", *n, width = bytes * 2))
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
                headers: &self.headers,
                state: None,
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
    let mut bless = crate::bless::Bless::new("wayback-runner-cases.json", &fixture);
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
                            headers: &headers,
                            state: None,
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
        // A case written by hand for PT_BLESS has no rows yet: it gets the
        // tables every recorded case has.
        let table_names: Vec<&str> = case["rows"].as_object().map_or_else(
            || {
                vec![
                    "apps",
                    "privacy_snapshots",
                    "notifications",
                    "activity_log",
                    "audit_log",
                    "app_settings",
                ]
            },
            |rows| rows.keys().map(String::as_str).collect(),
        );
        let rows = dump(&conn, &table_names);
        bless.record(
            case,
            &[
                ("calls", &calls),
                ("stream", &stream_json),
                ("rows", &rows),
                ("expected", wire.as_ref().unwrap_or(&Value::Null)),
            ],
        );
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
    if bless.finish() {
        return;
    }
    assert!(
        failures.is_empty(),
        "{} wayback runner parity failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

/// The survey runner over a scripted archive and a fake clock: a wait moves
/// the clock on instead of sleeping (`wayback_runner::fake_sleep`), so an
/// hour's wait costs nothing and the times it writes can be pinned. These
/// assert what the runner owns (the survey's listings, the waits, the
/// pause and cancel, the order, the totals in apps) and leave how many
/// pages an import reads to the history tests.
mod survey_runner {
    use crate::{
        outbound::{FetchFuture, Fetcher, Reply, Request},
        scrape::persist::{Ids, Shared, Writer},
        server::{
            operations::{self, Job},
            sync_runner::Clock,
            wayback_runner::{self, RunOptions, CAPTURE_CACHE_MAX_AGE_MS},
            writes::Cx,
        },
    };
    use regex::Regex;
    use rusqlite::{params, Connection};
    use serde_json::{json, Value};
    use std::{
        collections::HashMap,
        path::Path,
        sync::{
            atomic::{AtomicI64, Ordering},
            Arc, Mutex,
        },
    };

    /// 2026-09-15T12:00:00Z.
    const T0: i64 = 1_789_473_600_000;
    const DAY_MS: i64 = 24 * 60 * 60 * 1000;
    const PAGE: &str = r#"<html><head><script id="serialized-server-data">{"data":[{"data":{"shelfMapping":{"privacyTypes":{"items":[{"identifier":"DATA_LINKED_TO_YOU","title":"Data Linked to You","categories":[{"identifier":"CONTACT_INFO","title":"Contact Info"}]}]}}}}]}</script></head><body></body></html>"#;

    #[derive(Clone)]
    struct FakeClock(Arc<AtomicI64>);

    impl Clock for FakeClock {
        fn now(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    /// Ids of their own per test, so parallel runs never share a run id
    /// (the cancel registry is keyed by it).
    #[derive(Clone)]
    struct TestIds(&'static str, Arc<Mutex<u64>>);

    impl TestIds {
        fn next(&self) -> u64 {
            let mut n = self.1.lock().unwrap();
            *n += 1;
            *n
        }
    }

    impl Ids for TestIds {
        fn uuid(&mut self, _conn: &Connection) -> Result<String, String> {
            Ok(format!("{}-{:04}", self.0, self.next()))
        }
        fn short_id(&mut self, _conn: &Connection, prefix: &str) -> Result<String, String> {
            Ok(format!("{prefix}_{}-{:04}", self.0, self.next()))
        }
        fn hex_id(
            &mut self,
            _conn: &Connection,
            prefix: &str,
            _bytes: usize,
        ) -> Result<String, String> {
            Ok(format!("{prefix}{}{:04}", self.0, self.next()))
        }
        fn detach(&self) -> Option<Box<dyn Ids>> {
            Some(Box::new(self.clone()))
        }
    }

    /// One scripted answer, given before the normal one.
    enum Answer {
        Status(u16, Option<&'static str>),
        Refused,
        Garbage,
    }

    type Hook = Box<dyn FnMut(usize, &str) + Send>;

    /// archive.org as the tests script it: each app's CDX listing, a
    /// labelled page for every replay, scripted answers taken first by the
    /// first key the URL contains, and every request recorded. Save Page
    /// Now and the availability API are never expected in a bulk run.
    struct Archive {
        listings: HashMap<String, Vec<String>>,
        scripted: Mutex<Vec<(String, Answer)>>,
        calls: Mutex<Vec<String>>,
        hook: Mutex<Option<Hook>>,
    }

    fn reply(status: u16, body: &str, headers: Vec<(&str, &str)>, url: &str) -> Reply {
        Reply {
            status,
            body: body.as_bytes().to_vec(),
            headers: headers
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            final_url: url.to_string(),
        }
    }

    fn app_of(url: &str) -> String {
        let re = Regex::new(r"id(\d{6,})").unwrap();
        re.captures(url)
            .map(|c| c[1].to_string())
            .unwrap_or_default()
    }

    impl Fetcher for Archive {
        fn fetch(&self, request: Request) -> FetchFuture<'_> {
            Box::pin(async move {
                tokio::task::yield_now().await;
                let url = request.url.clone();
                let index = {
                    let mut calls = self.calls.lock().unwrap();
                    calls.push(url.clone());
                    calls.len() - 1
                };
                if let Some(hook) = self.hook.lock().unwrap().as_mut() {
                    hook(index, &url);
                }
                let scripted = {
                    let mut scripted = self.scripted.lock().unwrap();
                    scripted
                        .iter()
                        .position(|(key, _)| url.contains(key.as_str()))
                        .map(|at| scripted.remove(at).1)
                };
                match scripted {
                    Some(Answer::Status(status, retry_after)) => {
                        let headers = retry_after.map(|r| vec![("retry-after", r)]);
                        return Ok(reply(status, "", headers.unwrap_or_default(), &url));
                    }
                    Some(Answer::Refused) => return Err("fetch failed".to_string()),
                    Some(Answer::Garbage) => return Ok(reply(200, "<html>", vec![], &url)),
                    None => {}
                }
                if url.starts_with("https://web.archive.org/cdx/search/cdx?") {
                    let mut rows = vec![json!(["timestamp", "statuscode"])];
                    for ts in self.listings.get(&app_of(&url)).into_iter().flatten() {
                        rows.push(json!([ts, "200"]));
                    }
                    let body = Value::Array(rows).to_string();
                    return Ok(reply(
                        200,
                        &body,
                        vec![("content-type", "application/json")],
                        &url,
                    ));
                }
                if url.starts_with("https://web.archive.org/web/") && url.contains("id_/") {
                    return Ok(reply(200, PAGE, vec![("content-type", "text/html")], &url));
                }
                panic!("a bulk run asked for {url}");
            })
        }
    }

    struct Harness {
        conn: Arc<Mutex<Connection>>,
        clock: FakeClock,
        ids: TestIds,
        archive: Arc<Archive>,
    }

    fn url_of(id: &str) -> String {
        format!("https://apps.apple.com/us/app/fixture/id{id}")
    }

    /// `timestamps` days apart from 1 March 2021, as CDX spells them.
    fn timestamps(count: usize, every_days: i64) -> Vec<String> {
        (0..count as i64)
            .map(|i| {
                let ms = 1_614_600_000_000 + i * every_days * DAY_MS; // 2021-03-01T12:00Z
                let secs = ms / 1000;
                let days = secs.div_euclid(86_400);
                let (y, m, d) = crate::jsdate::civil_from_days(days);
                format!("{y:04}{m:02}{d:02}120000")
            })
            .collect()
    }

    impl Harness {
        /// A library of `(id, name)` apps, with the listing each has.
        fn new(name: &'static str, apps: &[(&str, &str, Vec<String>)]) -> Self {
            let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
            for (id, app_name, _) in apps {
                conn.execute(
                    "INSERT INTO apps (id, name, url, firstSeen, lastSynced, changeCount, \
                     changes_acknowledged_at, changes_snoozed_until) VALUES (?1, ?2, ?3, ?4, ?4, 0, 0, 0)",
                    params![id, app_name, url_of(id), T0 - 30 * DAY_MS],
                )
                .unwrap();
            }
            let listings = apps
                .iter()
                .map(|(id, _, listing)| (id.to_string(), listing.clone()))
                .collect();
            let clock = FakeClock(Arc::new(AtomicI64::new(T0)));
            let advance = clock.clone();
            wayback_runner::fake_sleep(Some(Arc::new(move |slept| {
                advance
                    .0
                    .fetch_add(slept.as_millis() as i64, Ordering::SeqCst);
            })));
            Self {
                conn: Arc::new(Mutex::new(conn)),
                clock,
                ids: TestIds(name, Arc::new(Mutex::new(0))),
                archive: Arc::new(Archive {
                    listings,
                    scripted: Mutex::new(vec![]),
                    calls: Mutex::new(vec![]),
                    hook: Mutex::new(None),
                }),
            }
        }

        fn script(&self, key: &str, answer: Answer) {
            self.archive
                .scripted
                .lock()
                .unwrap()
                .push((key.to_string(), answer));
        }

        fn hook(&self, hook: impl FnMut(usize, &str) + Send + 'static) {
            *self.archive.hook.lock().unwrap() = Some(Box::new(hook));
        }

        fn runtime() -> tokio::runtime::Runtime {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
        }

        /// A run from the routes, streaming: its result and its frames.
        fn run(
            &self,
            initiator: &'static str,
            resume_state: Option<Value>,
        ) -> (Result<Value, String>, Vec<Value>) {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let mut db = Shared {
                conn: self.conn.clone(),
                log: None,
                on_wait: None,
            };
            let mut ids = self.ids.clone();
            let result = Self::runtime().block_on(wayback_runner::run_bulk_wayback_import(
                &mut db,
                &*self.archive,
                &mut ids,
                &self.clock,
                RunOptions {
                    initiator,
                    resume_state,
                    stream_requested: true,
                    writer: Some(tx),
                    actor_ip: None,
                    user_agent: None,
                },
            ));
            let mut frames = vec![];
            while let Ok(frame) = rx.try_recv() {
                frames.push(frame);
            }
            (result.map(|r| r.totals), frames)
        }

        /// The boot-time check, with a run it resumes taken to its end.
        fn boot(&self) {
            let mut db = Shared {
                conn: self.conn.clone(),
                log: None,
                on_wait: None,
            };
            let mut ids = self.ids.clone();
            Self::runtime()
                .block_on(wayback_runner::resume_wayback_import(
                    &mut db,
                    &*self.archive,
                    &mut ids,
                    &self.clock,
                ))
                .unwrap();
        }

        fn calls(&self) -> Vec<String> {
            self.archive.calls.lock().unwrap().clone()
        }

        fn cdx_calls(&self) -> Vec<String> {
            self.calls()
                .iter()
                .filter(|u| u.contains("/cdx/search/cdx?"))
                .map(|u| app_of(u))
                .collect()
        }

        fn reads_of(&self, id: &str) -> usize {
            self.calls()
                .iter()
                .filter(|u| u.contains("id_/") && app_of(u) == id)
                .count()
        }

        fn setting(&self, key: &str) -> Option<String> {
            setting(&self.conn, key)
        }

        fn set_setting(&self, key: &str, value: &str) {
            self.conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
                    [key, value],
                )
                .unwrap();
        }

        fn state(&self) -> Option<Value> {
            self.setting("wayback_bulk_state")
                .map(|raw| serde_json::from_str(&raw).unwrap())
        }

        /// `(status, summary, detail.mode)` of every wayback activity row.
        fn activity(&self) -> Vec<(String, String, String)> {
            activity(&self.conn)
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            wayback_runner::fake_sleep(None);
        }
    }

    fn setting(conn: &Mutex<Connection>, key: &str) -> Option<String> {
        conn.lock()
            .unwrap()
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                [key],
                |r| r.get(0),
            )
            .ok()
    }

    fn activity(conn: &Mutex<Connection>) -> Vec<(String, String, String)> {
        let conn = conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT status, summary, json_extract(detail, '$.mode') FROM activity_log \
                 WHERE type = 'wayback_import' ORDER BY rowid",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows
    }

    /// What the PATCH does to a running queue: the request stored (and for
    /// a cancel, the run's token fired).
    fn request(conn: &Mutex<Connection>, action: &str, now: i64) {
        let run_id = {
            let guard = conn.lock().unwrap();
            let mut w = Writer::new(&guard, None);
            let mut ids = TestIds("patch", Arc::new(Mutex::new(0)));
            let cx = &mut Cx {
                w: &mut w,
                ids: &mut ids,
                now,
            };
            let mut state = wayback_runner::read_bulk_state(cx).expect("a running queue");
            let (status, at) = match action {
                "pause" => ("pause_requested", "pauseRequestedAt"),
                _ => ("cancel_requested", "cancelRequestedAt"),
            };
            wayback_runner::set(&mut state, "status", json!(status));
            wayback_runner::set(&mut state, at, json!(now));
            wayback_runner::write_bulk_state(cx, &state).unwrap();
            state["runId"].as_str().unwrap().to_string()
        };
        if action == "cancel" {
            assert!(wayback_runner::request_active_cancel(Some(&run_id)));
        }
    }

    fn of_type<'a>(frames: &'a [Value], kind: &str) -> Vec<&'a Value> {
        frames.iter().filter(|f| f["type"] == kind).collect()
    }

    fn kinds(frames: &[Value]) -> Vec<&str> {
        frames.iter().map(|f| f["type"].as_str().unwrap()).collect()
    }

    #[test]
    fn a_throttle_is_waited_out_and_the_same_app_asked_again() {
        let h = Harness::new(
            "wait-retry",
            &[
                ("710000001", "Alpha", timestamps(3, 200)),
                ("710000002", "Bravo", timestamps(2, 300)),
            ],
        );
        h.script("id710000001", Answer::Status(429, Some("120")));
        let conn = h.conn.clone();
        let seen = Arc::new(Mutex::new(vec![]));
        let seen_by_hook = seen.clone();
        h.hook(move |index, _| {
            // The stored state at each request: during the wait it said
            // so, and the retry no longer does.
            let state: Value =
                serde_json::from_str(&setting(&conn, "wayback_bulk_state").unwrap()).unwrap();
            seen_by_hook.lock().unwrap().push((
                index,
                state.get("waitingUntil").cloned(),
                state["consecutiveThrottles"].clone(),
            ));
        });
        let stored_during_wait = Arc::new(Mutex::new(None));
        {
            let conn = h.conn.clone();
            let clock = h.clock.clone();
            let stored = stored_during_wait.clone();
            wayback_runner::fake_sleep(Some(Arc::new(move |slept| {
                clock
                    .0
                    .fetch_add(slept.as_millis() as i64, Ordering::SeqCst);
                let mut stored = stored.lock().unwrap();
                if stored.is_none() {
                    *stored = setting(&conn, "wayback_bulk_state");
                }
            })));
        }

        let (totals, frames) = h.run("manual", None);
        let totals = totals.unwrap();

        // The listing was asked twice for Alpha, after the wait.
        assert_eq!(h.cdx_calls(), ["710000001", "710000001", "710000002"]);
        assert!(h.clock.now() >= T0 + 120_000, "the wait moved the clock");
        let waiting = of_type(&frames, "waiting");
        assert_eq!(waiting.len(), 1);
        assert_eq!(
            *waiting[0],
            json!({
                "type": "waiting",
                "appId": "710000001",
                "name": "Alpha",
                "until": T0 + 120_000,
                "reason": "archive.org rate-limited for CDX index — retry after 120s",
            })
        );
        let during: Value =
            serde_json::from_str(stored_during_wait.lock().unwrap().as_ref().unwrap()).unwrap();
        assert_eq!(during["waitingUntil"], T0 + 120_000);
        assert_eq!(
            during["waitReason"],
            "archive.org rate-limited for CDX index — retry after 120s"
        );
        assert_eq!(during["consecutiveThrottles"], 1);
        assert_eq!(during["phase"], "survey");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[1].0, 1, "the retry");
        assert_eq!(seen[1].1, None, "the wait is over before the retry");
        assert_eq!(seen[2].2, json!(0), "a listed app resets the count");

        // The run carried on and finished: both apps read, nothing failed.
        assert_eq!(
            kinds(&frames)[..6],
            [
                "batch-start",
                "phase",
                "waiting",
                "survey-app",
                "survey-app",
                "survey-done"
            ]
        );
        assert!(h.reads_of("710000001") > 0 && h.reads_of("710000002") > 0);
        assert_eq!(totals["appsDone"], 2);
        assert_eq!(totals["appsRead"], 2);
        assert_eq!(totals["appsNoArchive"], 0);
        assert_eq!(h.state(), None, "a finished run clears its state");
        assert_eq!(
            h.setting("wayback_import_running").as_deref(),
            Some("false")
        );
        let rows = h.activity();
        assert_eq!(
            rows[0],
            (
                "partial".to_string(),
                "archive.org is limiting requests; the Wayback import waits 2 min before retrying Alpha"
                    .to_string(),
                "bulk-wait".to_string()
            )
        );
        assert!(rows.iter().all(|(status, _, _)| status != "cancelled"));
    }

    #[test]
    fn a_refused_connection_while_reading_waits_five_minutes_then_rereads_the_app() {
        let h = Harness::new(
            "refused-read",
            &[("720000001", "Alpha", timestamps(4, 150))],
        );
        h.script("id_/", Answer::Refused);

        let (totals, frames) = h.run("manual", None);
        let totals = totals.unwrap();

        let waiting = of_type(&frames, "waiting");
        assert_eq!(waiting.len(), 1);
        let until = waiting[0]["until"].as_i64().unwrap();
        assert_eq!(until - T0, 300_000, "no Retry-After: five minutes");
        assert_eq!(
            waiting[0]["reason"],
            "archive.org refused the connection for replay"
        );
        // Started twice, done once, counted once.
        assert_eq!(of_type(&frames, "app-start").len(), 2);
        assert_eq!(of_type(&frames, "app-done").len(), 1);
        assert_eq!(totals["appsAttempted"], 1);
        assert_eq!(totals["appsDone"], 1);
        assert_eq!(
            h.cdx_calls(),
            ["720000001"],
            "the listing is not asked again"
        );
        assert!(h.clock.now() >= T0 + 300_000);
    }

    /// The paced client's stored cooldown outlasts the Retry-After: the
    /// wait covers it, rather than retrying into a throttle of its own.
    #[test]
    fn a_wait_covers_the_paced_clients_cooldown() {
        let h = Harness::new(
            "pacer-cooldown",
            &[("725000001", "Alpha", timestamps(3, 150))],
        );
        h.set_setting("wayback_cooldown_until", &(T0 + 600_000).to_string());
        h.script("id725000001", Answer::Status(429, Some("60")));
        let asked_at = Arc::new(Mutex::new(vec![]));
        {
            let clock = h.clock.clone();
            let asked_at = asked_at.clone();
            h.hook(move |_, _| asked_at.lock().unwrap().push(clock.now()));
        }

        let (totals, frames) = h.run("manual", None);
        assert_eq!(totals.unwrap()["appsDone"], 1);

        let waiting = of_type(&frames, "waiting");
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0]["until"], T0 + 600_000);
        assert_eq!(
            asked_at.lock().unwrap()[1],
            T0 + 600_000,
            "the retry waited"
        );
        let (_, summary, _) = h.activity().remove(0);
        assert_eq!(
            summary,
            "archive.org is limiting requests; the Wayback import waits 10 min before retrying Alpha"
        );
    }

    #[test]
    fn six_throttles_in_a_row_pause_the_queue() {
        let h = Harness::new(
            "six-throttles",
            &[
                ("730000001", "Alpha", timestamps(3, 100)),
                ("730000002", "Bravo", timestamps(3, 100)),
            ],
        );
        for _ in 0..6 {
            h.script("id730000001", Answer::Status(503, Some("60")));
        }

        let (totals, frames) = h.run("manual", None);
        assert!(totals.is_ok());

        assert_eq!(h.cdx_calls(), ["730000001"; 6]);
        assert_eq!(
            of_type(&frames, "waiting").len(),
            5,
            "five waits, then the pause"
        );
        assert_eq!(h.clock.now(), T0 + 5 * 60_000);
        let paused = of_type(&frames, "paused");
        assert_eq!(paused.len(), 1);
        assert_eq!(paused[0]["cause"], "rate_limited");
        let state = h.state().unwrap();
        assert_eq!(state["version"], 3);
        assert_eq!(state["status"], "paused");
        assert_eq!(state["pauseCause"], "rate_limited");
        assert_eq!(state["consecutiveThrottles"], 6);
        assert_eq!(state["phase"], "survey");
        assert!(
            state.get("waitingUntil").is_none(),
            "a paused queue is not waiting"
        );
        assert!(state.get("waitReason").is_none());
        assert_eq!(
            h.setting("wayback_import_running").as_deref(),
            Some("false")
        );
        let (status, summary, mode) = h.activity().pop().unwrap();
        assert_eq!(
            (status.as_str(), mode.as_str()),
            ("cancelled", "bulk-paused")
        );
        assert!(summary.contains("rate-limiting"), "{summary}");

        // Resume: the user asked to try again, so the count starts over,
        // and the survey carries on where it stopped.
        h.run("manual", Some(state)).0.unwrap();
        assert_eq!(h.cdx_calls()[6..], ["730000001", "730000002"]);
        assert_eq!(h.state(), None);
    }

    #[test]
    fn an_app_finishing_between_throttles_resets_the_count() {
        let h = Harness::new(
            "count-reset",
            &[
                ("740000001", "Alpha", timestamps(2, 100)),
                ("740000002", "Bravo", timestamps(2, 100)),
            ],
        );
        for _ in 0..5 {
            h.script(
                "cdx?url=https%3A%2F%2Fapps.apple.com%2Fus%2Fapp%2Ffixture%2Fid740000001",
                Answer::Status(429, Some("1")),
            );
        }
        for _ in 0..5 {
            h.script(
                "cdx?url=https%3A%2F%2Fapps.apple.com%2Fus%2Fapp%2Ffixture%2Fid740000002",
                Answer::Status(429, Some("1")),
            );
        }

        let (totals, frames) = h.run("manual", None);

        assert_eq!(of_type(&frames, "waiting").len(), 10);
        assert!(of_type(&frames, "paused").is_empty());
        assert_eq!(totals.unwrap()["appsDone"], 2);
    }

    #[test]
    fn a_pause_during_a_wait_parks_the_queue_at_once() {
        let h = Harness::new(
            "pause-in-wait",
            &[
                ("750000001", "Alpha", timestamps(3, 100)),
                ("750000002", "Bravo", timestamps(3, 100)),
            ],
        );
        h.script("id750000002", Answer::Status(429, Some("3600")));
        {
            // Ten seconds into the hour, the user pauses.
            let conn = h.conn.clone();
            let clock = h.clock.clone();
            let asked = Arc::new(Mutex::new(false));
            wayback_runner::fake_sleep(Some(Arc::new(move |d| {
                clock.0.fetch_add(d.as_millis() as i64, Ordering::SeqCst);
                let mut asked = asked.lock().unwrap();
                if !*asked && clock.now() >= T0 + 10_000 {
                    *asked = true;
                    request(&conn, "pause", clock.now());
                }
            })));
        }

        let (totals, frames) = h.run("manual", None);
        assert!(totals.is_ok());

        assert!(
            h.clock.now() < T0 + 12_000,
            "the pause did not wait out the hour"
        );
        let paused = of_type(&frames, "paused");
        assert_eq!(paused[0]["cause"], "user");
        let state = h.state().unwrap();
        assert_eq!(state["status"], "paused");
        assert!(state.get("waitingUntil").is_none());
        assert_eq!(state["queue"][0]["captureCount"], 3);
        assert!(
            state["queue"][1].get("captureCount").is_none(),
            "Bravo is still to list"
        );
        assert_eq!(state["consecutiveThrottles"], 1);

        // Resumed by hand: Bravo is listed, the count started over.
        let resumed_seen = Arc::new(Mutex::new(None));
        {
            let conn = h.conn.clone();
            let seen = resumed_seen.clone();
            h.hook(move |_, _| {
                let mut seen = seen.lock().unwrap();
                if seen.is_none() {
                    let state: Value =
                        serde_json::from_str(&setting(&conn, "wayback_bulk_state").unwrap())
                            .unwrap();
                    *seen = Some(state);
                }
            });
        }
        let (totals, frames) = h.run("manual", Some(state));
        assert_eq!(totals.unwrap()["appsDone"], 2);
        let first = resumed_seen.lock().unwrap().clone().unwrap();
        assert_eq!(first["consecutiveThrottles"], 0);
        assert_eq!(first["status"], "running");
        assert_eq!(first["phase"], "survey");
        assert_eq!(
            of_type(&frames, "survey-app")
                .iter()
                .map(|f| f["appId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["750000002"],
            "only Bravo was still to list"
        );
        assert_eq!(h.cdx_calls(), ["750000001", "750000002", "750000002"]);
    }

    #[test]
    fn a_cancel_during_a_wait_ends_the_run_at_once() {
        let h = Harness::new(
            "cancel-in-wait",
            &[("760000001", "Alpha", timestamps(3, 100))],
        );
        h.script("id_/", Answer::Status(429, Some("3600")));
        {
            let conn = h.conn.clone();
            let clock = h.clock.clone();
            let asked = Arc::new(Mutex::new(false));
            wayback_runner::fake_sleep(Some(Arc::new(move |d| {
                clock.0.fetch_add(d.as_millis() as i64, Ordering::SeqCst);
                let mut asked = asked.lock().unwrap();
                if !*asked && clock.now() >= T0 + 5_000 {
                    *asked = true;
                    request(&conn, "cancel", clock.now());
                }
            })));
        }

        let (totals, frames) = h.run("manual", None);
        assert!(totals.is_ok());

        assert!(h.clock.now() < T0 + 7_000);
        assert_eq!(of_type(&frames, "cancelled").len(), 1);
        assert_eq!(h.state(), None);
        assert_eq!(
            h.setting("wayback_import_running").as_deref(),
            Some("false")
        );
        let (status, summary, _) = h.activity().pop().unwrap();
        assert_eq!(status, "cancelled");
        assert!(summary.starts_with("Wayback import cancelled"), "{summary}");
    }

    #[test]
    fn a_pause_asked_for_while_an_app_is_read_stops_the_run_after_it() {
        let h = Harness::new(
            "pause-mid-app",
            &[
                ("770000001", "Alpha", timestamps(3, 100)),
                ("770000002", "Bravo", timestamps(3, 100)),
            ],
        );
        {
            let conn = h.conn.clone();
            let clock = h.clock.clone();
            let mut asked = false;
            h.hook(move |_, url| {
                if !asked && url.contains("id_/") {
                    asked = true;
                    request(&conn, "pause", clock.now());
                }
            });
        }

        let (totals, frames) = h.run("manual", None);
        assert!(totals.is_ok());

        // Alpha (as archived as Bravo, first by name) was finished, and its
        // end did not overwrite the request.
        let paused = of_type(&frames, "paused");
        assert_eq!(paused.len(), 1);
        assert_eq!(paused[0]["cause"], "user");
        assert_eq!(of_type(&frames, "app-done").len(), 1);
        let state = h.state().unwrap();
        assert_eq!(state["status"], "paused");
        assert_eq!(state["phase"], "reading");
        assert_eq!(state["queue"][0]["status"], "done");
        assert_eq!(state["queue"][1]["status"], "pending");
    }

    #[test]
    fn the_survey_reuses_a_fresh_listing_and_orders_the_queue() {
        let h = Harness::new(
            "survey-order",
            &[
                ("780000001", "Alpha", timestamps(3, 100)),
                ("780000002", "Bravo", timestamps(10, 50)),
                ("780000003", "Charlie", timestamps(5, 80)),
                ("780000004", "Delta", vec![]),
                ("780000005", "Echo", timestamps(4, 90)),
            ],
        );
        // Alpha was listed two days ago: reused, though the archive would
        // now say otherwise. Bravo's listing is a week old, Echo's is of an
        // address the app no longer has: both are asked again.
        let cache = |at: i64, url: &str, stamps: Vec<String>| {
            json!({ "fetchedAt": at, "url": url, "timestamps": stamps }).to_string()
        };
        h.set_setting(
            "wayback.captures.780000001",
            &cache(T0 - 2 * DAY_MS, &url_of("780000001"), timestamps(7, 30)),
        );
        h.set_setting(
            "wayback.captures.780000002",
            &cache(
                T0 - CAPTURE_CACHE_MAX_AGE_MS,
                &url_of("780000002"),
                timestamps(1, 1),
            ),
        );
        h.set_setting(
            "wayback.captures.780000005",
            &cache(
                T0,
                "https://apps.apple.com/gb/app/old/id780000005",
                timestamps(1, 1),
            ),
        );
        // Bravo has history imported already, so it waits its turn.
        h.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO privacy_snapshots (id, app_id, scraped_at, snapshot_json, \
                 changes_detected, changes_summary, source, wayback_snapshot_url, triggered_by) \
                 VALUES ('row-1', '780000002', ?1, '[]', 0, '[]', 'wayback', \
                 'https://web.archive.org/web/20210301120000/x', 'wayback')",
                [T0 - 400 * DAY_MS],
            )
            .unwrap();
        h.set_setting(
            "wayback_pacer_state",
            r#"{"perMinute":5,"consecutiveThrottles":0,"updatedAt":0}"#,
        );

        let (totals, frames) = h.run("manual", None);
        let totals = totals.unwrap();

        assert_eq!(
            h.cdx_calls(),
            ["780000002", "780000003", "780000004", "780000005"],
            "one listing per app without a fresh one, none while reading"
        );
        assert!(
            h.calls().iter().all(|u| !u.contains("/save/")),
            "no Save Page Now"
        );
        assert_eq!(
            h.reads_of("780000004"),
            0,
            "nothing read of an app with no captures"
        );

        let surveyed: Vec<(&str, i64, bool)> = of_type(&frames, "survey-app")
            .iter()
            .map(|f| {
                (
                    f["name"].as_str().unwrap(),
                    f["captureCount"].as_i64().unwrap(),
                    f["cached"].as_bool().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            surveyed,
            [
                ("Alpha", 7, true),
                ("Bravo", 10, false),
                ("Charlie", 5, false),
                ("Delta", 0, false),
                ("Echo", 4, false),
            ]
        );
        let delta = of_type(&frames, "survey-app")[3];
        assert_eq!(delta["firstCaptureMs"], Value::Null);

        // Never imported first, most archived first; Bravo after them; Delta
        // was finished in the survey and never started.
        let read: Vec<&str> = of_type(&frames, "app-start")
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert_eq!(read, ["Alpha", "Charlie", "Echo", "Bravo"]);
        let indexes: Vec<i64> = of_type(&frames, "app-start")
            .iter()
            .map(|f| f["index"].as_i64().unwrap())
            .collect();
        assert_eq!(indexes, [0, 1, 2, 3]);

        let done = of_type(&frames, "survey-done")[0];
        let survey = &done["survey"];
        assert_eq!(survey["appsSurveyed"], 5);
        assert_eq!(survey["appsWithCaptures"], 4);
        assert_eq!(survey["appsWithoutCaptures"], 1);
        assert_eq!(survey["capturesTotal"], 7 + 10 + 5 + 4);
        assert_eq!(survey["completedAt"], T0);
        let estimated: i64 = [(7, 30), (10, 50), (5, 80), (4, 90)]
            .iter()
            .map(|&(count, every)| {
                let stamps = timestamps(count, every);
                let ms = |ts: &str| crate::scrape::wayback::parse_timestamp_ms(Some(ts));
                wayback_runner::estimate_reads(
                    count as i64,
                    ms(&stamps[0]),
                    ms(stamps.last().unwrap()),
                    T0,
                )
            })
            .sum();
        assert_eq!(survey["estimatedReads"], estimated);
        let estimate = &done["estimate"];
        assert_eq!(estimate["readsRemaining"], estimated);
        assert_eq!(estimate["perMinute"], 5, "the pacer's rate");
        assert_eq!(estimate["etaMs"], estimated * 12_000);
        assert_eq!(
            of_type(&frames, "estimate").len(),
            4,
            "one after every app read"
        );

        // The listings asked for are cached; the fresh one is untouched.
        let cached: Value =
            serde_json::from_str(&h.setting("wayback.captures.780000003").unwrap()).unwrap();
        assert_eq!(
            cached,
            json!({ "fetchedAt": T0, "url": url_of("780000003"), "timestamps": timestamps(5, 80) })
        );
        let alpha: Value =
            serde_json::from_str(&h.setting("wayback.captures.780000001").unwrap()).unwrap();
        assert_eq!(alpha["fetchedAt"], T0 - 2 * DAY_MS);
        let delta_cache: Value =
            serde_json::from_str(&h.setting("wayback.captures.780000004").unwrap()).unwrap();
        assert_eq!(delta_cache["timestamps"], json!([]));

        assert_eq!(totals["appsDone"], 5);
        assert_eq!(totals["appsRead"], 4);
        assert_eq!(totals["appsNoArchive"], 1);
        assert_eq!(totals["appsAttempted"], 4);
        let results: Vec<&Value> = of_type(&frames, "app-done")
            .iter()
            .map(|f| &f["result"])
            .collect();
        for key in ["reads", "changes", "labelVersions"] {
            let sum: i64 = results.iter().map(|r| r[key].as_i64().unwrap_or(0)).sum();
            assert_eq!(totals[key], sum, "{key}");
        }
        let (status, summary, mode) = h.activity().pop().unwrap();
        assert_eq!((status.as_str(), mode.as_str()), ("ok", "bulk"));
        assert!(
            summary.starts_with("Wayback import: 5 of 5 apps checked, ")
                && summary.ends_with(", 1 app has no archived pages"),
            "{summary}"
        );
    }

    #[test]
    fn an_unreadable_index_fails_the_app_in_the_survey() {
        let h = Harness::new(
            "index-unreadable",
            &[
                ("790000001", "Alpha", timestamps(3, 100)),
                ("790000002", "Bravo", timestamps(2, 100)),
            ],
        );
        h.script(
            "cdx?url=https%3A%2F%2Fapps.apple.com%2Fus%2Fapp%2Ffixture%2Fid790000001",
            Answer::Garbage,
        );

        let (totals, frames) = h.run("manual", None);
        let totals = totals.unwrap();

        let alpha = of_type(&frames, "survey-app")[0];
        assert_eq!(alpha["captureCount"], Value::Null);
        assert_eq!(
            alpha["error"],
            "archive.org's capture index could not be read for this app"
        );
        assert_eq!(h.reads_of("790000001"), 0);
        assert!(h.reads_of("790000002") > 0);
        assert_eq!(
            h.cdx_calls(),
            ["790000001", "790000002"],
            "no availability probes"
        );
        assert_eq!(totals["appsDone"], 2);
        assert_eq!(totals["appsRead"], 1);
        let rows = h.activity();
        assert!(rows.iter().any(|(status, summary, _)| status == "error"
            && summary == "Wayback import failed for Alpha: archive.org's capture index could not be read for this app"));
        assert!(rows.last().unwrap().1.ends_with(", 1 failed"));
    }

    /// A v2 blob a process left mid-run: the v3 runner reads on with no
    /// survey, listing the index inside the import as before.
    #[test]
    fn a_v2_queue_resumes_as_a_reading_phase() {
        let h = Harness::new(
            "v2-resume",
            &[
                ("800000001", "Alpha", timestamps(3, 100)),
                ("800000002", "Bravo", timestamps(2, 100)),
            ],
        );
        let blob = json!({
            "version": 2,
            "runId": "v2-run",
            "startedAt": T0 - 60_000,
            "initiator": "manual",
            "updatedAt": T0 - 30_000,
            "currentAppId": "800000002",
            "status": "running",
            "queue": [
                { "appId": "800000001", "appName": "Alpha", "status": "done", "imported": 2,
                  "unchanged": 0, "skipped": 3, "failed": 0, "snapshotsRequested": 0 },
                { "appId": "800000002", "appName": "Bravo", "status": "in_progress", "startedAt": T0 - 30_000 },
            ],
            "totals": { "appsAttempted": 2, "appsWithImports": 1, "targetsAttempted": 5, "imported": 2,
                        "unchanged": 0, "skipped": 3, "failed": 0, "snapshotsRequested": 0 },
            "streamRequested": false,
        });
        h.set_setting("wayback_bulk_state", &blob.to_string());
        h.set_setting("wayback_import_running", "true");
        let first_write = Arc::new(Mutex::new(None));
        {
            let conn = h.conn.clone();
            let seen = first_write.clone();
            h.hook(move |_, _| {
                let mut seen = seen.lock().unwrap();
                if seen.is_none() {
                    *seen = setting(&conn, "wayback_bulk_state");
                }
            });
        }

        h.boot();

        // Bravo only, its index listed by the import itself.
        assert_eq!(h.cdx_calls(), ["800000002"]);
        assert_eq!(h.reads_of("800000001"), 0);
        assert!(h.reads_of("800000002") > 0);
        assert!(h.calls().iter().all(|u| !u.contains("/save/")));
        let during: Value =
            serde_json::from_str(first_write.lock().unwrap().as_ref().unwrap()).unwrap();
        assert_eq!(during["version"], 3);
        assert_eq!(during["phase"], "reading");
        assert_eq!(during["initiator"], "resume");
        assert!(during.get("survey").is_none(), "a v2 queue has no survey");
        assert_eq!(during["totals"]["appsDone"], 1, "counted from its queue");
        assert_eq!(
            during["totals"]["appsAttempted"], 2,
            "the app in flight un-counted, then counted"
        );
        assert!(during["estimate"].is_object());
        assert_eq!(h.state(), None);
        let rows = h.activity();
        let (_, summary, mode) = rows.last().unwrap();
        assert_eq!(mode, "bulk-resumed");
        assert!(
            summary.starts_with("Wayback import (resumed): 2 of 2 apps checked, "),
            "{summary}"
        );
    }

    /// A v3 blob a process left in the middle of its survey: the boot check
    /// resumes the survey from the first app it had not listed.
    #[test]
    fn a_run_stopped_mid_survey_resumes_its_survey() {
        let h = Harness::new(
            "mid-survey",
            &[
                ("810000001", "Alpha", timestamps(9, 100)),
                ("810000002", "Bravo", vec![]),
                ("810000003", "Charlie", timestamps(4, 100)),
            ],
        );
        h.set_setting(
            "wayback.captures.810000001",
            &json!({ "fetchedAt": T0 - 60_000, "url": url_of("810000001"), "timestamps": timestamps(9, 100) })
                .to_string(),
        );
        let stamps = timestamps(9, 100);
        let ms = |ts: &str| crate::scrape::wayback::parse_timestamp_ms(Some(ts)).unwrap();
        let mut totals = wayback_runner::zero_totals();
        totals["appsDone"] = json!(1);
        totals["appsNoArchive"] = json!(1);
        let blob = json!({
            "version": 3,
            "runId": "mid-survey-run",
            "startedAt": T0 - 60_000,
            "initiator": "manual",
            "updatedAt": T0 - 30_000,
            "currentAppId": null,
            "status": "running",
            "phase": "survey",
            "consecutiveThrottles": 0,
            "queue": [
                { "appId": "810000001", "appName": "Alpha", "status": "pending", "captureCount": 9,
                  "firstCaptureMs": ms(&stamps[0]), "lastCaptureMs": ms(&stamps[8]), "noArchive": false },
                { "appId": "810000002", "appName": "Bravo", "status": "done", "captureCount": 0,
                  "firstCaptureMs": null, "lastCaptureMs": null, "noArchive": true, "finishedAt": T0 - 40_000,
                  "reads": 0, "changes": 0, "labelVersions": 0 },
                { "appId": "810000003", "appName": "Charlie", "status": "pending" },
            ],
            "totals": totals,
            "survey": { "appsSurveyed": 2, "appsWithCaptures": 1, "appsWithoutCaptures": 1,
                        "capturesTotal": 9, "estimatedReads": 9, "completedAt": null },
            "streamRequested": true,
        });
        h.set_setting("wayback_bulk_state", &blob.to_string());
        h.set_setting("wayback_import_running", "true");
        let survey_done = Arc::new(Mutex::new(None));
        {
            let conn = h.conn.clone();
            let seen = survey_done.clone();
            h.hook(move |_, url| {
                // The first page read comes after the survey's last write.
                if url.contains("id_/") {
                    let mut seen = seen.lock().unwrap();
                    if seen.is_none() {
                        *seen = setting(&conn, "wayback_bulk_state");
                    }
                }
            });
        }

        h.boot();

        assert_eq!(
            h.cdx_calls(),
            ["810000003"],
            "only Charlie was still to list"
        );
        assert!(h.reads_of("810000001") > 0 && h.reads_of("810000003") > 0);
        assert_eq!(h.reads_of("810000002"), 0);
        let state: Value =
            serde_json::from_str(survey_done.lock().unwrap().as_ref().unwrap()).unwrap();
        assert_eq!(state["phase"], "reading");
        assert_eq!(state["survey"]["appsSurveyed"], 3);
        assert_eq!(state["survey"]["appsWithCaptures"], 2);
        assert_eq!(state["survey"]["capturesTotal"], 13);
        assert_eq!(state["survey"]["completedAt"], T0);
        let order: Vec<&str> = state["queue"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["appName"].as_str().unwrap())
            .collect();
        assert_eq!(order, ["Alpha", "Charlie", "Bravo"]);
        assert_eq!(h.state(), None);
        let rows = h.activity();
        assert!(rows.iter().any(|(_, _, mode)| mode == "bulk-resume-start"));
        let (_, summary, _) = rows.last().unwrap();
        assert!(
            summary.starts_with("Wayback import (resumed): 3 of 3 apps checked, ")
                && summary.ends_with(", 1 app has no archived pages"),
            "{summary}"
        );
    }

    /// A process that died waiting: the boot check waits out what is left
    /// of the wait before it asks archive.org anything.
    #[test]
    fn a_run_stopped_mid_wait_waits_out_the_rest_first() {
        let h = Harness::new("mid-wait", &[("820000001", "Alpha", timestamps(3, 100))]);
        let blob = json!({
            "version": 3,
            "runId": "mid-wait-run",
            "startedAt": T0 - 60_000,
            "initiator": "manual",
            "updatedAt": T0 - 30_000,
            "currentAppId": null,
            "status": "running",
            "phase": "survey",
            "consecutiveThrottles": 2,
            "queue": [{ "appId": "820000001", "appName": "Alpha", "status": "pending" }],
            "totals": wayback_runner::zero_totals(),
            "survey": { "appsSurveyed": 0, "appsWithCaptures": 0, "appsWithoutCaptures": 0,
                        "capturesTotal": 0, "estimatedReads": 0, "completedAt": null },
            "streamRequested": false,
            "waitingUntil": T0 + 90_000,
            "waitReason": "archive.org refused the connection for CDX index",
        });
        h.set_setting("wayback_bulk_state", &blob.to_string());
        h.set_setting("wayback_import_running", "true");
        let asked_at = Arc::new(Mutex::new(vec![]));
        {
            let clock = h.clock.clone();
            let asked_at = asked_at.clone();
            h.hook(move |_, _| asked_at.lock().unwrap().push(clock.now()));
        }

        h.boot();

        assert!(
            asked_at.lock().unwrap()[0] >= T0 + 90_000,
            "nothing asked inside the wait"
        );
        assert_eq!(h.state(), None);
    }

    #[test]
    fn the_estimate_counts_reads_left_at_the_pacers_rate() {
        // One change assumed: a skeleton read a year, then about log2 of
        // the captures between two of them, six at most.
        let ms = |s: &str| crate::scrape::wayback::parse_timestamp_ms(Some(s));
        assert_eq!(wayback_runner::estimate_reads(0, None, None, T0), 0);
        assert_eq!(
            wayback_runner::estimate_reads(1, ms("20250101"), ms("20250101"), T0),
            1
        );
        assert_eq!(
            wayback_runner::estimate_reads(2, ms("20250101"), ms("20260101"), T0),
            2
        );
        // Five yearly anchors inside a fully archived span: 7 + 6.
        assert_eq!(
            wayback_runner::estimate_reads(1744, ms("20210201"), ms("20260914"), T0),
            13
        );
        // One anchor (September 2025) inside, four captures: 3 + 1.
        assert_eq!(
            wayback_runner::estimate_reads(4, ms("20250101"), ms("20260101"), T0),
            4
        );
        // Unsurveyed (a resumed v2 queue): 500 captures assumed since the floor.
        assert_eq!(wayback_runner::estimate_reads(500, None, None, T0), 13);

        let state = json!({
            "totals": { "reads": 7 },
            "queue": [
                { "status": "done", "captureCount": 30, "firstCaptureMs": 0, "lastCaptureMs": 0 },
                { "status": "pending", "captureCount": 1744,
                  "firstCaptureMs": ms("20210201"), "lastCaptureMs": ms("20260914") },
                { "status": "pending", "captureCount": 0, "noArchive": true },
                { "status": "pending" },
            ],
        });
        assert_eq!(
            wayback_runner::compute_estimate(&state, 10.0, T0),
            json!({ "readsDone": 7, "readsRemaining": 26, "perMinute": 10, "etaMs": 156_000 })
        );
        assert_eq!(
            wayback_runner::compute_estimate(&state, 2.5, T0),
            json!({ "readsDone": 7, "readsRemaining": 26, "perMinute": 2.5, "etaMs": 624_000 })
        );
    }

    /// `GET /api/wayback/import-all` carries a v3 blob's progress, and
    /// projects an older blob exactly as before (some carry a `phase` that
    /// is not the survey's).
    #[test]
    fn the_status_route_projects_the_v3_fields_only_for_a_v3_blob() {
        let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
        let put = |blob: &Value| {
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('wayback_bulk_state', ?1)",
                [blob.to_string()],
            )
            .unwrap();
        };
        let mut blob = json!({
            "version": 3, "runId": "r", "startedAt": 1, "updatedAt": 2, "initiator": "manual",
            "currentAppId": null, "status": "running", "phase": "reading",
            "consecutiveThrottles": 2,
            "queue": [{ "appId": "1", "appName": "A", "status": "pending" }],
            "totals": { "appsDone": 0 },
            "survey": { "appsSurveyed": 1 },
            "estimate": { "etaMs": 6000 },
            "waitingUntil": 99, "waitReason": "archive.org rate-limited for replay",
        });
        put(&blob);
        let status = operations::job_status(&conn, Job::Wayback).unwrap();
        let state = &status["state"];
        let keys: Vec<&str> = state
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "runId",
                "startedAt",
                "updatedAt",
                "initiator",
                "status",
                "pausedAt",
                "pauseCause",
                "pauseRequestedAt",
                "cancelRequestedAt",
                "currentAppId",
                "totals",
                "phase",
                "waitingUntil",
                "waitReason",
                "consecutiveThrottles",
                "survey",
                "estimate",
            ]
        );
        assert_eq!(state["waitingUntil"], 99);
        assert_eq!(status["summary"]["pending"], 1);

        // Not waiting: no wait keys.
        blob.as_object_mut().unwrap().remove("waitingUntil");
        blob.as_object_mut().unwrap().remove("waitReason");
        put(&blob);
        let status = operations::job_status(&conn, Job::Wayback).unwrap();
        assert!(status["state"].get("waitingUntil").is_none());

        // A v1 blob with a stray phase projects as it always has.
        blob["version"] = json!(1);
        blob["phase"] = json!("all");
        put(&blob);
        let status = operations::job_status(&conn, Job::Wayback).unwrap();
        let keys: Vec<&str> = status["state"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "runId",
                "startedAt",
                "updatedAt",
                "initiator",
                "status",
                "pausedAt",
                "pauseCause",
                "pauseRequestedAt",
                "cancelRequestedAt",
                "currentAppId",
                "totals",
            ]
        );
        let described = operations::describe_run(&conn, Job::Wayback).unwrap();
        assert_eq!(described["state"]["version"], 2);
    }
}
