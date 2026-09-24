//! The boot-time resume checks leave a run their own server started alone,
//! and still take over one a previous process left behind: the Rust side of
//! `tests/app/bulk-resume-live-run.test.ts`, with the real runners and the
//! real checks on one server's connection. A run is held at its first
//! fetch, which is where a run started in the first seconds after boot
//! still is when the 8, 10 or 12 s check fires.
use super::{
    live_runs::Job,
    policy_runner::{self, resume_policy_sync, run_bulk_policy_sync},
    sync_runner::{resume_app_store_sync, run_bulk_sync, Fixed},
    wayback_runner::{self, resume_wayback_import, run_bulk_wayback_import},
};
use crate::{
    outbound::{FetchFuture, Fetcher, Reply, Request},
    scrape::persist::{Locked, RandomIds},
};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tokio::sync::Notify;

const NOW: i64 = 1_790_000_000_000;

/// Holds the first request until released, then answers it and every later
/// one with `reply`.
struct HoldFirst {
    reply: fn(&str) -> Reply,
    first: AtomicBool,
    arrived: Notify,
    release: Notify,
}

impl HoldFirst {
    fn new(reply: fn(&str) -> Reply) -> Self {
        Self {
            reply,
            first: AtomicBool::new(true),
            arrived: Notify::new(),
            release: Notify::new(),
        }
    }
}

impl Fetcher for HoldFirst {
    fn fetch(&self, request: Request) -> FetchFuture<'_> {
        Box::pin(async move {
            if self.first.swap(false, Ordering::SeqCst) {
                self.arrived.notify_one();
                self.release.notified().await;
            }
            Ok((self.reply)(&request.url))
        })
    }
}

fn reply(status: u16, body: &str, content_type: &str, url: &str) -> Reply {
    Reply {
        status,
        body: body.as_bytes().to_vec(),
        headers: vec![("content-type".to_string(), content_type.to_string())],
        final_url: url.to_string(),
    }
}

fn unavailable(url: &str) -> Reply {
    reply(503, "unavailable", "text/plain", url)
}

fn policy_text(url: &str) -> Reply {
    reply(
        200,
        &"Privacy policy text. ".repeat(200),
        "text/plain; charset=utf-8",
        url,
    )
}

fn empty_archive(url: &str) -> Reply {
    if url.starts_with("https://web.archive.org/cdx/search/cdx") {
        return reply(
            200,
            r#"[["timestamp","statuscode"]]"#,
            "application/json",
            url,
        );
    }
    assert!(url.starts_with("https://web.archive.org/save/"), "{url}");
    reply(503, "archive unavailable", "text/plain", url)
}

struct Case {
    job: Job,
    blob: &'static str,
    mutex: &'static str,
    notice: &'static str,
    reply: fn(&str) -> Reply,
}

const CASES: [Case; 3] = [
    Case {
        job: Job::Wayback,
        blob: "wayback_bulk_state",
        mutex: "wayback_import_running",
        notice: "__wayback_resume__",
        reply: empty_archive,
    },
    Case {
        job: Job::Sync,
        blob: "sync_bulk_state",
        mutex: "sync_running",
        notice: "__sync_resume__",
        reply: unavailable,
    },
    Case {
        job: Job::Policy,
        blob: "policy_bulk_state",
        mutex: "policy_sync_running",
        notice: "__policy_resume__",
        reply: policy_text,
    },
];

/// A server's connection with two tracked apps, each with a policy link.
fn server() -> Mutex<Connection> {
    let conn = crate::db::open_and_migrate(Path::new(":memory:")).unwrap();
    for (id, name) in [("910000001", "Alpha"), ("910000002", "Beta")] {
        conn.execute(
            "INSERT INTO apps (id, name, url, iconUrl, developer, privacyPolicyUrl, \
             firstSeen, lastSynced, changeCount) \
             VALUES (?1, ?2, ?3, '', 'Fixture Developer', ?4, ?5, ?5, 0)",
            params![
                id,
                name,
                format!("https://apps.apple.com/us/app/fixture/id{id}"),
                format!("https://example.com/privacy-{}", name.to_lowercase()),
                NOW
            ],
        )
        .unwrap();
    }
    Mutex::new(conn)
}

fn accessor(conn: &Mutex<Connection>) -> Locked<'_> {
    Locked {
        conn,
        log: None,
        on_wait: None,
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
        .optional()
        .unwrap()
}

fn set_setting(conn: &Mutex<Connection>, key: &str, value: &str) {
    conn.lock()
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            [key, value],
        )
        .unwrap();
}

fn activity_modes(conn: &Mutex<Connection>) -> Vec<String> {
    let conn = conn.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT json_extract(detail, '$.mode') FROM activity_log \
             WHERE json_extract(detail, '$.mode') IS NOT NULL ORDER BY started_at",
        )
        .unwrap();
    let modes = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<Vec<String>, _>>()
        .unwrap();
    modes
}

fn notices(conn: &Mutex<Connection>, app_id: &str) -> i64 {
    conn.lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM notifications WHERE app_id = ?1",
            [app_id],
            |r| r.get(0),
        )
        .unwrap()
}

/// The run, as Settings or the deferred policy fetch starts it.
async fn start(job: Job, conn: &Mutex<Connection>, fetcher: &HoldFirst) {
    let mut db = accessor(conn);
    let clock = Fixed(NOW);
    match job {
        Job::Sync => {
            run_bulk_sync(&mut db, fetcher, &mut RandomIds, &clock, "manual", None)
                .await
                .unwrap();
        }
        Job::Policy => {
            let ran = run_bulk_policy_sync(
                &mut db,
                fetcher,
                &mut RandomIds,
                &clock,
                policy_runner::RunOptions {
                    initiator: "manual",
                    phase: "fetch",
                    // So the fetch is not throttled away.
                    force: true,
                    resume_state: None,
                    stream_requested: false,
                    writer: None,
                    actor_ip: None,
                    user_agent: None,
                },
            )
            .await;
            ran.outcome.unwrap();
        }
        Job::Wayback => {
            run_bulk_wayback_import(
                &mut db,
                fetcher,
                &mut RandomIds,
                &clock,
                wayback_runner::RunOptions {
                    initiator: "manual",
                    resume_state: None,
                    stream_requested: false,
                    writer: None,
                    actor_ip: None,
                    user_agent: None,
                },
            )
            .await
            .unwrap();
        }
    }
}

/// The job's boot-time check, as `start_background` arms it.
async fn boot_check(job: Job, conn: &Mutex<Connection>, fetcher: &HoldFirst) {
    let mut db = accessor(conn);
    let clock = Fixed(NOW);
    match job {
        Job::Sync => resume_app_store_sync(&mut db, fetcher, &mut RandomIds, &clock)
            .await
            .unwrap(),
        Job::Policy => {
            resume_policy_sync(&mut db, fetcher, &mut RandomIds, &clock).await;
        }
        Job::Wayback => resume_wayback_import(&mut db, fetcher, &mut RandomIds, &clock)
            .await
            .unwrap(),
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// A run is held at its first fetch while the boot check runs on the same
/// server: the check must leave it alone, and the run then finishes as the
/// only run.
fn started_since_boot(case: &Case) {
    let conn = server();
    let fetcher = HoldFirst::new(case.reply);
    runtime().block_on(async {
        let probe = async {
            fetcher.arrived.notified().await;
            let blob = setting(&conn, case.blob);
            assert!(blob.is_some(), "the run wrote its blob");
            assert_eq!(setting(&conn, case.mutex).as_deref(), Some("true"));

            boot_check(case.job, &conn, &fetcher).await;

            assert_eq!(
                setting(&conn, case.blob),
                blob,
                "the live run's blob is untouched"
            );
            assert_eq!(
                setting(&conn, case.mutex).as_deref(),
                Some("true"),
                "and so is its mutex"
            );
            assert!(
                !activity_modes(&conn).contains(&"bulk-resume-start".to_string()),
                "no resume row"
            );
            assert_eq!(notices(&conn, case.notice), 0, "no resume notification");
            fetcher.release.notify_one();
        };
        tokio::join!(start(case.job, &conn, &fetcher), probe);
    });
    let summaries: Vec<String> = activity_modes(&conn)
        .into_iter()
        .filter(|m| m == "bulk" || m == "bulk-resumed")
        .collect();
    assert_eq!(summaries, ["bulk"], "one run, one summary row");
    assert_ne!(setting(&conn, case.mutex).as_deref(), Some("true"));
}

/// The rows a process killed mid-app leaves behind, taken from a real run
/// that then finishes, so nothing of it is live on this server: the boot
/// check still resumes them.
fn left_behind(case: &Case) {
    let conn = server();
    let fetcher = HoldFirst::new(case.reply);
    let rt = runtime();
    let left = rt.block_on(async {
        let probe = async {
            fetcher.arrived.notified().await;
            let left = setting(&conn, case.blob).expect("the run wrote its blob");
            fetcher.release.notify_one();
            left
        };
        tokio::join!(start(case.job, &conn, &fetcher), probe).1
    });
    conn.lock()
        .unwrap()
        .execute("DELETE FROM activity_log", [])
        .unwrap();
    set_setting(&conn, case.blob, &left);
    set_setting(&conn, case.mutex, "true");

    rt.block_on(boot_check(case.job, &conn, &fetcher));

    let modes = activity_modes(&conn);
    assert_eq!(
        modes.iter().filter(|m| *m == "bulk-resume-start").count(),
        1,
        "the check resumed it"
    );
    assert!(
        modes.contains(&"bulk-resumed".to_string()),
        "the resumed summary"
    );
    assert_eq!(notices(&conn, case.notice), 1, "and said so");
    assert_ne!(setting(&conn, case.mutex).as_deref(), Some("true"));
}

#[test]
fn a_wayback_run_started_since_boot_is_not_resumed_by_its_own_server() {
    started_since_boot(&CASES[0]);
}

#[test]
fn a_wayback_run_a_previous_process_left_behind_is_still_resumed() {
    left_behind(&CASES[0]);
}

#[test]
fn a_sync_run_started_since_boot_is_not_resumed_by_its_own_server() {
    started_since_boot(&CASES[1]);
}

#[test]
fn a_sync_run_a_previous_process_left_behind_is_still_resumed() {
    left_behind(&CASES[1]);
}

#[test]
fn a_policy_run_started_since_boot_is_not_resumed_by_its_own_server() {
    started_since_boot(&CASES[2]);
}

#[test]
fn a_policy_run_a_previous_process_left_behind_is_still_resumed() {
    left_behind(&CASES[2]);
}
