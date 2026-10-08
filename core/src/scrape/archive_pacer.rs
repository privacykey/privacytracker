//! One pace for every archive.org request a server makes (P1 of
//! docs/WAYBACK_IMPORT.md). archive.org answers a burst with 429, then
//! blocks the client for minutes and refuses its connections, so the bulk
//! import, a per-app import and the policy store share one budget here
//! instead of each going as fast as it can.
//!
//! - Requests to `archive.org`, `web.archive.org` and `www.web.archive.org`
//!   take a slot, first come first served, at `perMinute` slots a minute:
//!   10 to start, never below 2 or above 15, halved by a throttle and
//!   raised by one after every 20 successes in a row. Every other host
//!   passes straight through.
//! - A throttle (a 429, any 5xx, or a transport failure
//!   [`Unavailable::transport`] classifies) starts a cooldown of the
//!   longer of its Retry-After and a base of 5 minutes that doubles with
//!   each throttle in a row, both capped at 60 minutes. A success resets
//!   the count. During a cooldown a request gets a synthetic 429 whose
//!   Retry-After is the time left, and never reaches the network; the
//!   archive client already reads that as [`Unavailable`].
//! - `wayback_cooldown_until` and `wayback_pacer_state` in `app_settings`
//!   are read when the server starts and written whenever they change, so
//!   a restart keeps a cooldown.
//!
//! A pacer belongs to a server, not the process: [`register`] files it
//! against the server's connection (as `live_runs.rs` files a run), and
//! [`paced`] finds it from any section. A connection nothing registered,
//! which is every replay harness, gets the pass-through pacer: no waits,
//! no cooldowns, no writes, so the recorded oracles see exactly the
//! requests they recorded. Wrap a fetcher once: a pacer under a pacer
//! takes two slots per request.
use super::{
    persist::DbAccess,
    wayback::{parse_retry_after_ms, Unavailable},
};
use crate::{
    jsnum::js_parse_int,
    outbound::{FetchFuture, Fetcher, Reply, Request, StreamFuture},
    server::settings::{get_setting_with, set_setting_with},
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    future::Future,
    ops::Deref,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak},
    time::Duration,
};
use url::Url;

/// The hosts that share the pace.
pub(crate) const ARCHIVE_HOSTS: [&str; 3] =
    ["archive.org", "web.archive.org", "www.web.archive.org"];
/// `app_settings` key: when the current cooldown ends, epoch milliseconds.
pub(crate) const COOLDOWN_KEY: &str = "wayback_cooldown_until";
/// `app_settings` key: `{"perMinute", "consecutiveThrottles", "updatedAt"}`.
pub(crate) const STATE_KEY: &str = "wayback_pacer_state";
pub(crate) const START_PER_MINUTE: u32 = 10;
pub(crate) const MIN_PER_MINUTE: u32 = 2;
pub(crate) const MAX_PER_MINUTE: u32 = 15;
/// Successes in a row that raise the rate by one a minute.
pub(crate) const SUCCESSES_PER_STEP: u32 = 20;
pub(crate) const BASE_COOLDOWN_MS: i64 = 5 * 60_000;
pub(crate) const MAX_COOLDOWN_MS: i64 = 60 * 60_000;

/// The pacer's time: the wall clock for cooldowns, which are stored as
/// epoch milliseconds, and a sleep for the slots. Tests drive a fake one.
pub(crate) trait PacerClock: Send + Sync {
    fn now_ms(&self) -> i64;
    fn sleep(&self, ms: u64) -> Pin<Box<dyn Future<Output = ()> + Send>>;
}

pub(crate) struct SystemClock;

impl PacerClock for SystemClock {
    fn now_ms(&self) -> i64 {
        crate::server::now_ms()
    }
    fn sleep(&self, ms: u64) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(tokio::time::sleep(Duration::from_millis(ms)))
    }
}

/// Where the two keys live: `app_settings` on a server, a map in tests.
pub(crate) trait PacerStore: Send + Sync {
    fn read(&self, key: &str) -> Option<String>;
    fn write(&self, key: &str, value: &str);
}

/// The server's `app_settings`, through its one connection. Held weakly,
/// so a pacer never keeps a stopped server's database open.
pub(crate) struct SettingsStore(Weak<Mutex<Connection>>);

impl SettingsStore {
    pub(crate) fn new(conn: &Arc<Mutex<Connection>>) -> Self {
        Self(Arc::downgrade(conn))
    }
}

impl PacerStore for SettingsStore {
    fn read(&self, key: &str) -> Option<String> {
        let conn = self.0.upgrade()?;
        let guard = crate::server::lifecycle::lock_db(&conn);
        get_setting_with(&guard, key, "")
            .ok()
            .filter(|v| !v.is_empty())
    }
    fn write(&self, key: &str, value: &str) {
        let Some(conn) = self.0.upgrade() else {
            return;
        };
        let guard = crate::server::lifecycle::lock_db(&conn);
        if let Err(e) = set_setting_with(&guard, key, value) {
            crate::server::diag::log_warn(format!("[WaybackPacer] Could not save {key}: {e}"));
        }
    }
}

/// What a request may do now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Admission {
    /// Its slot has come: send it.
    Go,
    /// archive.org is cooling down for this many more milliseconds.
    CoolingDown(i64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct State {
    per_minute: u32,
    consecutive_throttles: u32,
    /// Successes since the last throttle or rate step; never stored.
    successes: u32,
    cooldown_until: i64,
    updated_at: i64,
    /// When the last slot was granted; never stored, so the first request
    /// after a start goes at once.
    last_grant: Option<i64>,
}

impl State {
    /// Whatever the two keys hold, made sane: garbage is no cooldown and
    /// the starting rate, and a stored rate is clamped to its bounds.
    fn load(store: &dyn PacerStore) -> Self {
        let cooldown_until = store
            .read(COOLDOWN_KEY)
            .and_then(|raw| js_parse_int(&raw))
            .filter(|ms| *ms > 0)
            .unwrap_or(0);
        let saved: Value = store
            .read(STATE_KEY)
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or(Value::Null);
        let count = |key: &str| {
            saved[key]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(f64::floor)
        };
        Self {
            per_minute: count("perMinute").map_or(START_PER_MINUTE, |n| {
                n.clamp(f64::from(MIN_PER_MINUTE), f64::from(MAX_PER_MINUTE)) as u32
            }),
            consecutive_throttles: count("consecutiveThrottles")
                .map_or(0, |n| n.min(1000.0) as u32),
            successes: 0,
            cooldown_until,
            updated_at: saved["updatedAt"].as_i64().unwrap_or(0),
            last_grant: None,
        }
    }

    fn interval_ms(&self) -> i64 {
        60_000 / i64::from(self.per_minute.max(1))
    }

    fn stored_json(&self) -> String {
        json!({
            "perMinute": self.per_minute,
            "consecutiveThrottles": self.consecutive_throttles,
            "updatedAt": self.updated_at,
        })
        .to_string()
    }
}

/// `max(Retry-After, base)`'s base: 5 minutes for the first throttle in a
/// row, doubled for each one after it, never over the cap.
fn base_cooldown_ms(consecutive_throttles: u32) -> i64 {
    let doublings = consecutive_throttles.saturating_sub(1).min(4);
    (BASE_COOLDOWN_MS << doublings).min(MAX_COOLDOWN_MS)
}

/// Which keys a change has to write.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Changed {
    Nothing,
    State,
    StateAndCooldown,
}

struct Live {
    clock: Arc<dyn PacerClock>,
    store: Option<Arc<dyn PacerStore>>,
    /// The queue for slots. Tokio's mutex is fair: callers get their turn
    /// in the order they asked, whoever they are.
    gate: tokio::sync::Mutex<()>,
    state: Mutex<State>,
    /// Held while the keys are written, so a slower write never lands an
    /// older state over a newer one.
    saving: Mutex<()>,
}

impl Live {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn save(&self, changed: Changed) {
        let Some(store) = &self.store else {
            return;
        };
        if changed == Changed::Nothing {
            return;
        }
        let _saving = self.saving.lock().unwrap_or_else(PoisonError::into_inner);
        let state = *self.state();
        if changed == Changed::StateAndCooldown {
            store.write(COOLDOWN_KEY, &state.cooldown_until.to_string());
        }
        store.write(STATE_KEY, &state.stored_json());
    }
}

/// A server's archive.org pace, or the pass-through one.
pub(crate) struct Pacer {
    live: Option<Live>,
}

impl Pacer {
    /// Paces nothing: every request goes at once and nothing it answers
    /// changes anything. What a replay harness gets.
    pub(crate) fn unpaced() -> Self {
        Self { live: None }
    }

    /// A pacer on `clock`, starting from what `store` holds.
    pub(crate) fn new(clock: Arc<dyn PacerClock>, store: Option<Arc<dyn PacerStore>>) -> Self {
        let state = State::load(store.as_deref().unwrap_or(&NoStore));
        Self {
            live: Some(Live {
                clock,
                store,
                gate: tokio::sync::Mutex::new(()),
                state: Mutex::new(state),
                saving: Mutex::new(()),
            }),
        }
    }

    /// The server's pacer: the wall clock, and the server's own
    /// `app_settings`, read now.
    pub(crate) fn for_server(conn: &Arc<Mutex<Connection>>) -> Self {
        Self::new(
            Arc::new(SystemClock),
            Some(Arc::new(SettingsStore::new(conn))),
        )
    }

    pub(crate) fn is_paced(&self) -> bool {
        self.live.is_some()
    }

    /// The rate now, in requests a minute. Readers outside the tests (the
    /// bulk runner's estimate) read the stored keys instead.
    #[cfg(test)]
    pub(crate) fn per_minute(&self) -> u32 {
        self.live
            .as_ref()
            .map_or(START_PER_MINUTE, |live| live.state().per_minute)
    }

    /// Throttles in a row so far.
    #[cfg(test)]
    pub(crate) fn consecutive_throttles(&self) -> u32 {
        self.live
            .as_ref()
            .map_or(0, |live| live.state().consecutive_throttles)
    }

    /// Milliseconds left on the cooldown, or zero.
    #[cfg(test)]
    pub(crate) fn cooldown_remaining_ms(&self) -> i64 {
        self.live.as_ref().map_or(0, |live| {
            (live.state().cooldown_until - live.clock.now_ms()).max(0)
        })
    }

    /// Waits for the request's slot, or says how long archive.org is still
    /// cooling down. A caller dropped while it waits gives its turn back:
    /// it took no slot, and the next caller's wait is measured from the
    /// last slot actually used.
    pub(crate) async fn admit(&self) -> Admission {
        let Some(live) = &self.live else {
            return Admission::Go;
        };
        let cooling = {
            let state = live.state();
            state.cooldown_until - live.clock.now_ms()
        };
        if cooling > 0 {
            return Admission::CoolingDown(cooling);
        }
        let _turn = live.gate.lock().await;
        loop {
            let now = live.clock.now_ms();
            let wait = {
                let mut state = live.state();
                if state.cooldown_until > now {
                    return Admission::CoolingDown(state.cooldown_until - now);
                }
                let interval = state.interval_ms();
                // Clamped, so a wall clock set back cannot stretch a wait
                // past one slot.
                let wait = state
                    .last_grant
                    .map_or(0, |last| (last + interval - now).clamp(0, interval));
                if wait == 0 {
                    state.last_grant = Some(now);
                    return Admission::Go;
                }
                wait
            };
            live.clock.sleep(wait as u64).await;
        }
    }

    /// What one paced request came back with. A throttle halves the rate
    /// and starts (or lengthens) the cooldown; a success resets the
    /// throttle count and, every twentieth in a row, raises the rate. Any
    /// other failure (a blocked URL, a body over the cap) is neither.
    pub(crate) fn observe(&self, outcome: &Result<Reply, String>) {
        let Some(live) = &self.live else {
            return;
        };
        let now = live.clock.now_ms();
        let throttled = match outcome {
            Ok(reply) if reply.status == 429 || reply.status >= 500 => {
                Some(parse_retry_after_ms(reply.header("retry-after"), now))
            }
            Ok(_) => None,
            Err(error) if Unavailable::transport(error, "archive.org").is_some() => Some(None),
            Err(_) => return,
        };
        let changed = {
            let mut state = live.state();
            match throttled {
                Some(retry_after_ms) => {
                    state.consecutive_throttles = state.consecutive_throttles.saturating_add(1);
                    state.successes = 0;
                    state.per_minute = (state.per_minute / 2).max(MIN_PER_MINUTE);
                    let cooldown = retry_after_ms
                        .unwrap_or(0)
                        .max(base_cooldown_ms(state.consecutive_throttles))
                        .min(MAX_COOLDOWN_MS);
                    state.cooldown_until = state.cooldown_until.max(now + cooldown);
                    state.updated_at = now;
                    Changed::StateAndCooldown
                }
                None => {
                    let mut changed = Changed::Nothing;
                    if state.consecutive_throttles > 0 {
                        state.consecutive_throttles = 0;
                        changed = Changed::State;
                    }
                    state.successes += 1;
                    if state.successes >= SUCCESSES_PER_STEP {
                        state.successes = 0;
                        if state.per_minute < MAX_PER_MINUTE {
                            state.per_minute += 1;
                            changed = Changed::State;
                        }
                    }
                    if changed != Changed::Nothing {
                        state.updated_at = now;
                    }
                    changed
                }
            }
        };
        live.save(changed);
    }
}

/// A store with nothing in it, for a pacer that keeps nothing.
struct NoStore;
impl PacerStore for NoStore {
    fn read(&self, _key: &str) -> Option<String> {
        None
    }
    fn write(&self, _key: &str, _value: &str) {}
}

/// Is this request for archive.org?
pub(crate) fn is_archive_host(url: &str) -> bool {
    Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h.trim_end_matches('.').to_ascii_lowercase())
        })
        .is_some_and(|host| ARCHIVE_HOSTS.contains(&host.as_str()))
}

/// What a request gets during a cooldown instead of the network: a 429
/// whose Retry-After is the time left, in whole seconds, rounded up.
pub(crate) fn cooling_reply(request: &Request, remaining_ms: i64) -> Reply {
    let seconds = (remaining_ms.max(1) + 999) / 1000;
    Reply {
        status: 429,
        body: vec![],
        headers: vec![("retry-after".to_string(), seconds.to_string())],
        final_url: request.url.clone(),
    }
}

/// Any fetcher, with its archive.org requests paced. `F` is the fetcher
/// borrowed for a request or owned by a run spawned off one.
pub(crate) struct Paced<F> {
    inner: F,
    pacer: Arc<Pacer>,
}

impl<F> Paced<F> {
    pub(crate) fn new(inner: F, pacer: Arc<Pacer>) -> Self {
        Self { inner, pacer }
    }
}

impl<F> Fetcher for Paced<F>
where
    F: Deref + Send + Sync,
    F::Target: Fetcher,
{
    fn fetch(&self, request: Request) -> FetchFuture<'_> {
        Box::pin(async move {
            if !self.pacer.is_paced() || !is_archive_host(&request.url) {
                return self.inner.fetch(request).await;
            }
            match self.pacer.admit().await {
                Admission::CoolingDown(remaining_ms) => Ok(cooling_reply(&request, remaining_ms)),
                Admission::Go => {
                    let outcome = self.inner.fetch(request).await;
                    self.pacer.observe(&outcome);
                    outcome
                }
            }
        })
    }
    /// Only the AI calls stream, and never to archive.org.
    fn fetch_stream(&self, request: Request) -> StreamFuture<'_> {
        self.inner.fetch_stream(request)
    }
    /// A run spawned off the request keeps the same pacer.
    fn shared(&self) -> Option<Arc<dyn Fetcher>> {
        let inner = self.inner.shared()?;
        Some(Arc::new(Paced {
            inner,
            pacer: self.pacer.clone(),
        }))
    }
}

// ── One pacer per server ─────────────────────────────────────────────

/// The registered pacers, by the address of their server's connection.
static SERVERS: Mutex<Vec<(usize, Arc<Pacer>)>> = Mutex::new(Vec::new());

fn server(conn: &Connection) -> usize {
    std::ptr::from_ref(conn) as usize
}

fn servers() -> MutexGuard<'static, Vec<(usize, Arc<Pacer>)>> {
    SERVERS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A server's pacer, filed until this drops. The server keeps it for as
/// long as it runs; dropping it on stop means a later server whose
/// connection lands at the same address starts with its own.
#[must_use = "the pacer is registered only while this is held"]
pub(crate) struct Registration {
    key: usize,
    pacer: Arc<Pacer>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let mut servers = servers();
        if let Some(at) = servers
            .iter()
            .position(|(key, pacer)| *key == self.key && Arc::ptr_eq(pacer, &self.pacer))
        {
            servers.swap_remove(at);
        }
    }
}

/// Files `pacer` as the pace of the server whose connection this is,
/// replacing any earlier one.
pub(crate) fn register(conn: &Connection, pacer: Arc<Pacer>) -> Registration {
    let key = server(conn);
    let mut servers = servers();
    servers.retain(|(k, _)| *k != key);
    servers.push((key, pacer.clone()));
    Registration { key, pacer }
}

/// The pace of this connection's server: its registered pacer, or the
/// pass-through one when nothing registered it.
pub(crate) fn for_connection(conn: &Connection) -> Arc<Pacer> {
    static UNPACED: OnceLock<Arc<Pacer>> = OnceLock::new();
    let key = server(conn);
    servers()
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, pacer)| pacer.clone())
        .unwrap_or_else(|| UNPACED.get_or_init(|| Arc::new(Pacer::unpaced())).clone())
}

/// `fetcher` at the pace of the server behind `db`. The injection point:
/// a server registers its pacer when it starts, and a replay's connection,
/// which nobody registers, gets the pass-through one.
pub(crate) fn paced<'a>(db: &mut dyn DbAccess, fetcher: &'a dyn Fetcher) -> Paced<&'a dyn Fetcher> {
    let pacer = db.with(|w| for_connection(w.conn));
    Paced::new(fetcher, pacer)
}
