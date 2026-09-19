//! Replays `core/tests/fixtures/policy-summary-cases.json`.
//!
//! SYNC cases run `sync_policy_analysis` in the case's phase against a
//! database seeded with its setup, the recorded replies served through the
//! REAL transport: the fetch loop for the policy page, the streamed fetch
//! for the model. The clock ticks when an awaited request is answered —
//! one second, or the time a timeout hung for — and Save Page Now, fired
//! and forgotten, is free and runs after the sync into the `late` stream.
//! Compared: every raw fetch, the write stream, the late stream, seven
//! tables and the return value.
//!
//! A reply's body reaches the reader in the chunks the recording gave it,
//! one read per chunk as undici's body stream delivers them, so a stream
//! cut off mid-way and a reply over the two-megabyte cap stop at the same
//! byte on both sides.
//!
//! SAMPLE cases run `summarize_sample_privacy_policy` with the case's
//! configuration; PREVIEW cases compare the prompt preview.
use super::{
    policy_ai::is_abort_or_timeout,
    policy_store::{run_follow_ups, sync_policy_analysis, Phase, PolicyRequest, SyncOptions},
    policy_store_tests::{compare, runtime, seeded, statements, Ticking, Utc},
    policy_summary::{build_policy_summary_prompt_preview, summarize_sample_privacy_policy},
};
use crate::{
    outbound::{
        fetch_via, stream_via, FetchFuture, Fetcher, Hop, HopFuture, Outgoing, RawReply, Request,
        StreamFuture, TIMEOUT_MESSAGE,
    },
    policy::ai::AiConfig,
    scrape::{
        persist::Locked,
        persist_tests::{dump, CountingIds},
    },
    server::backup::base64_decode_lenient,
};
use axum::body::Bytes;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    Arc, Mutex,
};
use url::Url;

const TABLES: [&str; 7] = [
    "privacy_policy_analyses",
    "privacy_policy_versions",
    "privacy_snapshots",
    "notifications",
    "activity_log",
    "ai_debug_log",
    "app_settings",
];
const TICK: i64 = 1000;
const WEBHOOK: &str = "https://hooks.example.com/pt";

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/policy-summary-cases.json"
    ))
    .unwrap()
}

/// One recorded chunk: text, base64 bytes, or a run of one character.
fn chunk_bytes(chunk: &Value) -> Vec<u8> {
    if let Some(text) = chunk.as_str() {
        return text.as_bytes().to_vec();
    }
    if let Some(fill) = chunk.get("fill") {
        let byte = fill["char"].as_str().unwrap().as_bytes()[0];
        return vec![byte; fill["bytes"].as_u64().unwrap() as usize];
    }
    base64_decode_lenient(chunk["b64"].as_str().unwrap())
}

/// The reply the stub answered with, or the error it threw: a timeout's
/// and an abort's `DOMException`, or a `TypeError`.
fn canned_reply(reply: &Value) -> Result<RawReply, String> {
    if let Some(kind) = reply["throws"].as_str() {
        return Err(match kind {
            "timeout" => TIMEOUT_MESSAGE.to_string(),
            "abort" => "This operation was aborted".to_string(),
            other => other.to_string(),
        });
    }
    if let Some(error) = reply["error"].as_str() {
        return Err(error.to_string());
    }
    let mut headers = HeaderMap::new();
    if let Some(map) = reply["headers"].as_object() {
        for (name, value) in map {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value.as_str().unwrap()).unwrap(),
            );
        }
    }
    let status = reply["status"].as_u64().unwrap() as u16;
    let mut chunks: Vec<std::io::Result<Bytes>> = Vec::new();
    if ![204, 205, 304].contains(&status) {
        if let Some(parts) = reply["chunks"].as_array() {
            chunks.extend(parts.iter().map(|c| Ok(Bytes::from(chunk_bytes(c)))));
        } else if reply.get("fill").is_some() {
            chunks.push(Ok(Bytes::from(chunk_bytes(reply))));
        } else {
            let body = reply["body"].as_str().unwrap_or("").as_bytes().to_vec();
            if !body.is_empty() {
                chunks.push(Ok(Bytes::from(body)));
            }
        }
        match reply["streamError"].as_str() {
            Some("timeout") => chunks.push(Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                TIMEOUT_MESSAGE,
            ))),
            Some(_) => chunks.push(Err(std::io::Error::other("terminated"))),
            None => {}
        }
    }
    // No `BufReader`: each read hands back one whole recorded chunk.
    let body = tokio_util::io::StreamReader::new(futures_util::stream::iter(chunks));
    Ok(RawReply {
        status,
        headers,
        body: Box::pin(body),
    })
}

pub(super) struct Canned {
    replies: Vec<Value>,
    cursor: AtomicUsize,
    pub(super) calls: Mutex<Vec<Value>>,
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
    fn note_encoding(&self, request: &Request) {
        self.explicit_encoding.store(
            request
                .headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("accept-encoding")),
            Ordering::SeqCst,
        );
    }
}

impl Hop for Canned {
    fn hop(&self, url: Url, headers: HeaderMap, outgoing: Outgoing) -> HopFuture<'_> {
        Box::pin(async move {
            let explicit = self.explicit_encoding.load(Ordering::SeqCst);
            // Node's stub saw exactly the headers the caller set.
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
            let index = self.cursor.fetch_add(1, Ordering::SeqCst);
            let Some(reply) = self.replies.get(index) else {
                return Err(format!("Missing fixture reply for {url}"));
            };
            let free = url.as_str().starts_with("https://web.archive.org/save/")
                || url.as_str() == WEBHOOK;
            if !free {
                self.clock
                    .fetch_add(reply["advance"].as_i64().unwrap_or(TICK), Ordering::SeqCst);
            }
            canned_reply(reply)
        })
    }
}

impl Fetcher for Canned {
    fn fetch(&self, request: Request) -> FetchFuture<'_> {
        self.note_encoding(&request);
        Box::pin(async move { fetch_via(self, request).await })
    }
    fn fetch_stream(&self, request: Request) -> StreamFuture<'_> {
        self.note_encoding(&request);
        Box::pin(async move { stream_via(self, request).await })
    }
}

fn phase(options: &Value) -> Phase {
    match options["phase"].as_str() {
        Some("fetch") => Phase::Fetch,
        Some("summarise") => Phase::Summarise,
        _ => Phase::All,
    }
}

fn run_sync(rt: &tokio::runtime::Runtime, case: &Value) -> Vec<String> {
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
        phase: phase(&case["options"]),
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
    wrong
}

fn config_of(value: &Value) -> AiConfig {
    let provider = match value["provider"].as_str().unwrap() {
        "openai" => "openai",
        "anthropic" => "anthropic",
        _ => "custom",
    };
    AiConfig {
        provider,
        api_key: value["apiKey"].as_str().unwrap().to_string(),
        base_url: value["baseUrl"].as_str().unwrap().to_string(),
        model: value["model"].as_str().unwrap().to_string(),
        label: value["label"].as_str().unwrap().to_string(),
    }
}

fn run_sample(rt: &tokio::runtime::Runtime, case: &Value) -> Vec<String> {
    let mutex = Mutex::new(seeded(&case["setup"]));
    let clock = Arc::new(AtomicI64::new(case["now"].as_i64().unwrap()));
    let ticking = Ticking(clock.clone());
    let fetcher = Canned::new(case["replies"].as_array().unwrap().clone(), clock.clone());
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
        rt.block_on(summarize_sample_privacy_policy(
            &mut db,
            &mut ids,
            &fetcher,
            &ticking,
            &config_of(&case["aiConfig"]),
            case["audience"] == "guardian",
        ))
    };
    let expected = match outcome {
        Ok(result) => json!({"ok": true, "result": result}),
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
    compare(
        &mut wrong,
        "rows",
        &case["rows"],
        &dump(&mutex.lock().unwrap(), &TABLES),
    );
    compare(&mut wrong, "result", &case["expected"], &expected);
    wrong
}

fn run_preview(case: &Value) -> Vec<String> {
    let input = &case["input"];
    let mut ids = CountingIds {
        prefix: "00000000-0000-4000-8000-",
        next: 0,
    };
    let actual = build_policy_summary_prompt_preview(
        &mut ids,
        input["appName"].as_str().unwrap(),
        input["developer"].as_str(),
        input["policyUrl"].as_str().unwrap(),
        input["policyText"].as_str().unwrap(),
        input["audience"] == "guardian",
    );
    let mut wrong = vec![];
    compare(&mut wrong, "preview", &case["expected"], &actual);
    wrong
}

#[test]
fn policy_summariser_matches_node_calls_streams_rows_and_result() {
    let _utc = Utc::new();
    let fixture = fixture();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 72, "fixture has {} cases", cases.len());
    let rt = runtime();
    let mut failures: Vec<String> = vec![];
    for case in cases {
        let wrong = match case["kind"].as_str().unwrap() {
            "sync" => run_sync(&rt, case),
            "sample" => run_sample(&rt, case),
            "preview" => run_preview(case),
            other => vec![format!("unknown case kind {other}")],
        };
        if !wrong.is_empty() {
            failures.push(format!("{}\n{}", case["name"], wrong.join("\n")));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} summariser parity failures:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n\n")
    );
    assert!(is_abort_or_timeout(TIMEOUT_MESSAGE));
}
