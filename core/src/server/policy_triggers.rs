//! Phase 5, batch 4b: the two ways Node starts policy work on its own.
//!
//! - **The policy after a scrape** (`fetchAndParseApp(url, resync, true)`):
//!   once the scrape has committed, the app's policy goes through
//!   `syncPrivacyPolicyAnalysis`. `POST /api/scrape` asks for it with
//!   `summarizePolicies: true`; the dev seed's live walk always does.
//! - **The deferred fetch** (`lib/post-app-update-policy-fetch.ts`): a
//!   successful scrape without that flag, an import that brought apps in
//!   and a bulk App Store sync that synced any each ask for one fetch-only
//!   policy run. The requests coalesce behind a two-second timer. The
//!   drain skips while scraping is off, waits five minutes (at most three
//!   times) while another policy run holds the lock, and otherwise runs
//!   the bulk runner as `automatic`.
//!
//! The queue is process state, as Node's module state is. The server
//! installs a factory at startup that hands the timer an owned accessor,
//! fetcher, id source and clock; without one (a replay) a request is only
//! queued, and the replay drains it itself, as Node's oracle calls
//! `__drainForTests`. Under `cfg(test)` the queue is per thread, so the
//! replays that reach these call sites never see each other's requests.
//! Gated by `core/tests/fixtures/policy-triggers-cases.json`, replayed by
//! `policy_triggers_tests`.
pub(crate) use super::policy_store::FollowUps;
use super::{
    policy_runner::{can_start_manual_run, run_bulk_policy_sync, RunOptions},
    policy_store::{run_follow_ups, sync_policy_analysis, PolicyRequest, SyncOptions},
    sync_runner::{clock_for, Clock},
    writes::Cx,
};
use crate::{
    outbound::Fetcher,
    scrape::{
        persist::{DbAccess, Ids},
        Outcome,
    },
};
use std::{collections::BTreeSet, sync::Arc, time::Duration};

const DEFAULT_DELAY: Duration = Duration::from_millis(2000);
const BUSY_RETRY_DELAY: Duration = Duration::from_secs(5 * 60);
const MAX_BUSY_RETRIES: u32 = 3;

// ── The policy after a scrape ────────────────────────────────────────

/// `if (summarizePolicies) await syncPrivacyPolicyAnalysis(...)`: the app
/// the scrape just wrote, its link and developer as the page gave them (no
/// link clears its analysis). A failure is logged, not raised, and never
/// fails the scrape.
pub(crate) async fn summarize_after_scrape(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    now: i64,
    outcome: &Outcome,
) -> FollowUps {
    let clock = clock_for(now);
    let request = PolicyRequest {
        app_id: outcome.id.clone(),
        app_name: outcome.name.clone(),
        developer: Some(outcome.developer.clone()),
        policy_url: Some(outcome.policy_url.clone()),
    };
    match sync_policy_analysis(db, ids, fetcher, &*clock, &request, SyncOptions::default()).await {
        Ok(synced) => synced.follow_ups,
        Err(e) => {
            super::diag::log_error(format!(
                "Privacy policy analysis failed for {} {e}",
                outcome.name
            ));
            FollowUps::default()
        }
    }
}

#[cfg(test)]
thread_local! {
    /// What a replay's scrape paths left to finish, collected for the
    /// harness to run after the case, where Node's held replies land.
    static LATE: std::cell::RefCell<Vec<FollowUps>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// What a route's policy runs fired and could not finish in place: on the
/// server nothing (Save Page Now was spawned where Node fires it); in a
/// replay, the archive-link writes, handed to the harness.
pub(crate) async fn finish_later(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    now: i64,
    follow_ups: Vec<FollowUps>,
) {
    #[cfg(test)]
    {
        let _ = (db, fetcher, now);
        LATE.with(|late| late.borrow_mut().extend(follow_ups));
    }
    #[cfg(not(test))]
    {
        let clock = clock_for(now);
        for follow_up in follow_ups {
            run_follow_ups(db, fetcher, &*clock, follow_up).await;
        }
    }
}

/// The follow-ups a replay's routes left, taken.
#[cfg(test)]
pub(crate) fn take_late() -> Vec<FollowUps> {
    LATE.with(|late| std::mem::take(&mut *late.borrow_mut()))
}

// ── The deferred fetch ───────────────────────────────────────────────

/// `pendingReasons`, `timer` and `busyRetries`.
#[derive(Default)]
struct Queue {
    pending: BTreeSet<&'static str>,
    armed: bool,
    busy_retries: u32,
}

#[cfg(test)]
thread_local! {
    static QUEUE: std::cell::RefCell<Queue> = std::cell::RefCell::new(Queue::default());
}
#[cfg(not(test))]
static QUEUE: std::sync::Mutex<Queue> = std::sync::Mutex::new(Queue {
    pending: BTreeSet::new(),
    armed: false,
    busy_retries: 0,
});

fn with_queue<R>(f: impl FnOnce(&mut Queue) -> R) -> R {
    #[cfg(test)]
    {
        QUEUE.with(|q| f(&mut q.borrow_mut()))
    }
    #[cfg(not(test))]
    {
        f(&mut QUEUE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    }
}

/// A fresh queue for the next replay case.
#[cfg(test)]
pub(crate) fn reset_for_tests() {
    with_queue(|q| *q = Queue::default());
    let _ = take_late();
}

/// What the timer's run owns.
pub(crate) struct Handles {
    pub db: Box<dyn DbAccess>,
    pub fetcher: Arc<dyn Fetcher>,
    pub ids: Box<dyn Ids>,
    pub clock: Arc<dyn Clock>,
}

type Factory = Box<dyn Fn() -> Handles + Send + Sync>;
static FACTORY: std::sync::OnceLock<Factory> = std::sync::OnceLock::new();

/// The server's handles for the timer, installed once at startup.
pub(crate) fn install(factory: Factory) {
    let _ = FACTORY.set(factory);
}

/// `schedulePostAppUpdatePolicyFetch(reason)`: queue the reason and arm
/// the two-second timer unless one is armed.
pub(crate) fn schedule(reason: &'static str) {
    let arm = with_queue(|q| {
        q.pending.insert(reason);
        !std::mem::replace(&mut q.armed, true)
    });
    if arm && !arm_timer(DEFAULT_DELAY) {
        with_queue(|q| q.armed = false);
    }
}

/// `armTimer`: a task that sleeps, drains, and while the runner is busy
/// sleeps again — unless a request armed a timer of its own meanwhile.
fn arm_timer(delay: Duration) -> bool {
    if cfg!(test) {
        return false;
    }
    let Some(factory) = FACTORY.get() else {
        return false;
    };
    if tokio::runtime::Handle::try_current().is_err() {
        return false;
    }
    let mut handles = factory();
    tokio::spawn(async move {
        let mut delay = delay;
        loop {
            tokio::time::sleep(delay).await;
            // `timer = null`: a request from here on arms a timer of its own.
            with_queue(|q| q.armed = false);
            let drained = drain(
                &mut *handles.db,
                &*handles.fetcher,
                &mut *handles.ids,
                &*handles.clock,
            )
            .await;
            for follow_up in drained.follow_ups {
                run_follow_ups(
                    &mut *handles.db,
                    &*handles.fetcher,
                    &*handles.clock,
                    follow_up,
                )
                .await;
            }
            if drained.retry && !with_queue(|q| std::mem::replace(&mut q.armed, true)) {
                delay = BUSY_RETRY_DELAY;
                continue;
            }
            break;
        }
    });
    true
}

/// What a drain did: whether it wants to wait and try again, and what its
/// run left to finish.
#[derive(Default)]
pub(crate) struct Drained {
    pub retry: bool,
    pub follow_ups: Vec<FollowUps>,
}

/// `drainPolicyFetchQueue`.
pub(crate) async fn drain(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    ids: &mut dyn Ids,
    clock: &dyn Clock,
) -> Drained {
    let reasons: Vec<&'static str> =
        with_queue(|q| std::mem::take(&mut q.pending).into_iter().collect());
    if reasons.is_empty() {
        return Drained::default();
    }
    let label = reasons.join("+");
    let now = clock.now();
    // Scraping switched off: no run, no retry, and no Activity row either;
    // it is the state the user chose.
    let disabled = db.with(|w| Cx { w, ids, now }.get("policy_scrape_disabled", "false"));
    if disabled == "true" {
        with_queue(|q| q.busy_retries = 0);
        super::diag::log_warn(format!(
            "[PolicyFetch] Deferred {label} policy fetch skipped because policy scraping is disabled in Settings"
        ));
        return Drained::default();
    }
    if !db.with(|w| can_start_manual_run(&Cx { w, ids, now })) {
        let retry = with_queue(|q| {
            if q.busy_retries < MAX_BUSY_RETRIES {
                q.busy_retries += 1;
                q.pending.extend(reasons);
                true
            } else {
                q.busy_retries = 0;
                false
            }
        });
        return Drained {
            retry,
            follow_ups: vec![],
        };
    }
    with_queue(|q| q.busy_retries = 0);
    let ran = run_bulk_policy_sync(
        db,
        fetcher,
        ids,
        clock,
        RunOptions {
            initiator: "automatic",
            phase: "fetch",
            force: false,
            resume_state: None,
            stream_requested: false,
            writer: None,
            actor_ip: None,
            user_agent: None,
        },
    )
    .await;
    if let Err(e) = &ran.outcome {
        super::diag::log_warn(format!(
            "[PolicyFetch] Deferred {label} policy source fetch failed: {e}"
        ));
    }
    Drained {
        retry: false,
        follow_ups: ran.follow_ups,
    }
}
