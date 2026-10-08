//! The archive.org pacer (`archive_pacer.rs`) on a fake clock: slot
//! spacing, the adaptive rate, the cooldowns a 429, a 5xx and a refused
//! connection start and the synthetic 429 they answer with, what it stores
//! and reloads, the hosts it leaves alone, two callers at once, a dropped
//! wait, and the registry that gives a replay the pass-through pacer.
use super::{
    archive_pacer::{
        for_connection, paced, register, Admission, Paced, Pacer, PacerClock, PacerStore,
        SettingsStore, COOLDOWN_KEY, STATE_KEY,
    },
    persist::Locked,
    wayback::{self, SaveResult, Unavailable},
};
use crate::{
    outbound::{FetchFuture, Fetcher, Reply, Request, TIMEOUT_MESSAGE},
    server::settings::get_setting_with,
};
use futures_util::FutureExt;
use rusqlite::Connection;
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Poll, Waker},
};

const T0: i64 = 1_760_000_000_000;
const CDX: &str = "https://web.archive.org/cdx/search/cdx?url=x";
const APP: &str = "https://apps.apple.com/us/app/fixture/id555000111";

/// Time that moves only when a test says so. `auto` clocks jump ahead by
/// whatever a sleep asks for, for one caller at a time; `manual` ones park
/// the sleeper until [`FakeClock::advance`] passes its deadline.
#[derive(Clone)]
struct FakeClock(Arc<Mutex<Fake>>);

struct Fake {
    now: i64,
    auto: bool,
    slept: Vec<u64>,
    wakers: Vec<Waker>,
}

impl FakeClock {
    fn new(now: i64, auto: bool) -> Self {
        Self(Arc::new(Mutex::new(Fake {
            now,
            auto,
            slept: vec![],
            wakers: vec![],
        })))
    }
    fn auto(now: i64) -> Self {
        Self::new(now, true)
    }
    fn manual(now: i64) -> Self {
        Self::new(now, false)
    }
    fn now(&self) -> i64 {
        self.0.lock().unwrap().now
    }
    fn slept(&self) -> Vec<u64> {
        self.0.lock().unwrap().slept.clone()
    }
    fn advance(&self, ms: i64) {
        let wakers = {
            let mut fake = self.0.lock().unwrap();
            fake.now += ms;
            std::mem::take(&mut fake.wakers)
        };
        for waker in wakers {
            waker.wake();
        }
    }
}

impl PacerClock for FakeClock {
    fn now_ms(&self) -> i64 {
        self.now()
    }
    fn sleep(&self, ms: u64) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let mut fake = self.0.lock().unwrap();
        fake.slept.push(ms);
        if fake.auto {
            fake.now += ms as i64;
            return Box::pin(std::future::ready(()));
        }
        let deadline = fake.now + ms as i64;
        let clock = self.0.clone();
        Box::pin(std::future::poll_fn(move |cx| {
            let mut fake = clock.lock().unwrap();
            if fake.now >= deadline {
                Poll::Ready(())
            } else {
                fake.wakers.push(cx.waker().clone());
                Poll::Pending
            }
        }))
    }
}

fn pacer_on(clock: &FakeClock) -> Pacer {
    Pacer::new(Arc::new(clock.clone()), None)
}

fn reply(status: u16, headers: &[(&str, &str)]) -> Reply {
    Reply {
        status,
        body: b"{}".to_vec(),
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        final_url: String::new(),
    }
}

fn get(url: &str) -> Request {
    Request::apple(url.to_string(), &[], 1024, 1000)
}

/// The network: canned replies in order (a 200 once they run out), and
/// every request that reached it, with the fake time it arrived.
#[derive(Clone)]
struct Network {
    clock: FakeClock,
    replies: Arc<Mutex<VecDeque<Result<Reply, String>>>>,
    calls: Arc<Mutex<Vec<(String, i64)>>>,
    shareable: bool,
}

impl Network {
    fn new(clock: &FakeClock, replies: Vec<Result<Reply, String>>) -> Self {
        Self {
            clock: clock.clone(),
            replies: Arc::new(Mutex::new(replies.into())),
            calls: Arc::new(Mutex::new(vec![])),
            shareable: true,
        }
    }
    fn calls(&self) -> Vec<(String, i64)> {
        self.calls.lock().unwrap().clone()
    }
    fn times(&self) -> Vec<i64> {
        self.calls().into_iter().map(|(_, at)| at).collect()
    }
}

impl Fetcher for Network {
    fn fetch(&self, request: Request) -> FetchFuture<'_> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push((request.url.clone(), self.clock.now()));
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(reply(200, &[])))
        })
    }
    fn shared(&self) -> Option<Arc<dyn Fetcher>> {
        self.shareable
            .then(|| Arc::new(self.clone()) as Arc<dyn Fetcher>)
    }
}

/// A map standing in for `app_settings`, counting its writes.
#[derive(Default)]
struct MapStore {
    values: Mutex<HashMap<String, String>>,
    writes: Mutex<usize>,
}

impl MapStore {
    fn with(entries: &[(&str, &str)]) -> Self {
        let store = Self::default();
        for (k, v) in entries {
            store
                .values
                .lock()
                .unwrap()
                .insert(k.to_string(), v.to_string());
        }
        store
    }
    fn writes(&self) -> usize {
        *self.writes.lock().unwrap()
    }
}

impl PacerStore for MapStore {
    fn read(&self, key: &str) -> Option<String> {
        self.values.lock().unwrap().get(key).cloned()
    }
    fn write(&self, key: &str, value: &str) {
        *self.writes.lock().unwrap() += 1;
        self.values
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// Lets every spawned task run until it parks.
async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

#[test]
fn slots_are_spaced_at_the_rate() {
    let clock = FakeClock::auto(T0);
    let network = Network::new(&clock, vec![]);
    let pacer = Arc::new(pacer_on(&clock));
    let archive = Paced::new(&network, pacer.clone());
    runtime().block_on(async {
        for _ in 0..3 {
            archive.fetch(get(CDX)).await.unwrap();
        }
    });
    // Ten a minute: the first at once, then one every six seconds.
    assert_eq!(network.times(), [T0, T0 + 6_000, T0 + 12_000]);
    assert_eq!(clock.slept(), [6_000, 6_000]);

    // The stored rate sets the spacing: 15 a minute is every 4 s, 2 every 30 s.
    for (per_minute, gap) in [("15", 4_000), ("2", 30_000)] {
        let clock = FakeClock::auto(T0);
        let network = Network::new(&clock, vec![]);
        let state =
            format!(r#"{{"perMinute":{per_minute},"consecutiveThrottles":0,"updatedAt":1}}"#);
        let store = Arc::new(MapStore::with(&[(STATE_KEY, &state)]));
        let pacer = Arc::new(Pacer::new(Arc::new(clock.clone()), Some(store)));
        let archive = Paced::new(&network, pacer);
        runtime().block_on(async {
            archive.fetch(get(CDX)).await.unwrap();
            archive.fetch(get(CDX)).await.unwrap();
        });
        assert_eq!(network.times(), [T0, T0 + gap], "{per_minute} a minute");
    }
}

#[test]
fn throttles_halve_the_rate_and_successes_raise_it() {
    let clock = FakeClock::auto(T0);
    let pacer = pacer_on(&clock);
    let ok = Ok(reply(200, &[]));
    let throttled = Ok(reply(429, &[]));
    assert_eq!(pacer.per_minute(), 10);
    pacer.observe(&throttled);
    assert_eq!(pacer.per_minute(), 5);
    pacer.observe(&throttled);
    assert_eq!(pacer.per_minute(), 2);
    pacer.observe(&throttled);
    assert_eq!(pacer.per_minute(), 2, "never below two a minute");

    // One more a minute after every twenty successes in a row.
    for _ in 0..19 {
        pacer.observe(&ok);
    }
    assert_eq!(pacer.per_minute(), 2);
    pacer.observe(&ok);
    assert_eq!(pacer.per_minute(), 3);
    // A throttle in a run of successes starts the count again, and a
    // reply that is not archive.org refusing us (a 404, a redirect) is a
    // success.
    for _ in 0..19 {
        pacer.observe(&ok);
    }
    pacer.observe(&throttled);
    assert_eq!(pacer.per_minute(), 2, "three halved is held at two");
    for _ in 0..10 {
        pacer.observe(&Ok(reply(404, &[])));
    }
    for _ in 0..9 {
        pacer.observe(&Ok(reply(302, &[])));
    }
    assert_eq!(pacer.per_minute(), 2);
    pacer.observe(&ok);
    assert_eq!(pacer.per_minute(), 3);
    // Failures that are not archive.org refusing us count for nothing.
    let cooldown = pacer.cooldown_remaining_ms();
    for _ in 0..40 {
        pacer.observe(&Err("safeFetch: response exceeded 4194304 bytes".into()));
    }
    assert_eq!(pacer.per_minute(), 3);
    assert_eq!(pacer.consecutive_throttles(), 0);
    assert_eq!(pacer.cooldown_remaining_ms(), cooldown);
    // Never above fifteen.
    for _ in 0..(20 * 20) {
        pacer.observe(&ok);
    }
    assert_eq!(pacer.per_minute(), 15);
}

#[test]
fn a_429_a_5xx_and_a_refused_connection_start_a_cooldown() {
    let throttles: Vec<(Result<Reply, String>, &str)> = vec![
        (Ok(reply(429, &[])), "429"),
        (Ok(reply(500, &[])), "500"),
        (Ok(reply(503, &[])), "503"),
        (Err("fetch failed".into()), "refused"),
        (Err("terminated".into()), "dropped"),
        (Err(TIMEOUT_MESSAGE.into()), "timed out"),
        (
            Err("Blocked URL: host web.archive.org did not resolve to a public address".into()),
            "unresolved",
        ),
    ];
    for (outcome, label) in throttles {
        let clock = FakeClock::auto(T0);
        let pacer = pacer_on(&clock);
        pacer.observe(&outcome);
        assert_eq!(pacer.cooldown_remaining_ms(), 300_000, "{label}");
        assert_eq!(pacer.consecutive_throttles(), 1, "{label}");
    }

    // The longer of Retry-After and the base, capped at an hour.
    for (retry_after, cooldown) in [("600", 600_000), ("60", 300_000), ("86400", 3_600_000)] {
        let clock = FakeClock::auto(T0);
        let pacer = pacer_on(&clock);
        pacer.observe(&Ok(reply(429, &[("retry-after", retry_after)])));
        assert_eq!(
            pacer.cooldown_remaining_ms(),
            cooldown,
            "Retry-After {retry_after}"
        );
    }

    // The base doubles with each throttle in a row, up to an hour, and a
    // success brings it back to five minutes.
    let clock = FakeClock::auto(T0);
    let pacer = pacer_on(&clock);
    for minutes in [5, 10, 20, 40, 60, 60] {
        pacer.observe(&Ok(reply(503, &[])));
        assert_eq!(pacer.cooldown_remaining_ms(), minutes * 60_000);
        clock.advance(minutes * 60_000);
    }
    pacer.observe(&Ok(reply(200, &[])));
    assert_eq!(pacer.consecutive_throttles(), 0);
    pacer.observe(&Ok(reply(503, &[])));
    assert_eq!(pacer.cooldown_remaining_ms(), 300_000);

    // A throttle never shortens a cooldown already running.
    let clock = FakeClock::auto(T0);
    let pacer = pacer_on(&clock);
    pacer.observe(&Ok(reply(429, &[("retry-after", "3600")])));
    clock.advance(60_000);
    pacer.observe(&Ok(reply(503, &[])));
    assert_eq!(pacer.cooldown_remaining_ms(), 3_540_000);

    // Not throttles: these leave no cooldown.
    let quiet: Vec<Result<Reply, String>> = vec![
        Ok(reply(404, &[])),
        Ok(reply(302, &[])),
        Err("safeFetch: response exceeded 4194304 bytes".into()),
        Err("safeFetch: too many redirects (6)".into()),
        Err("Blocked URL: host_not_allowed — Hostname x is not on the allowlist".into()),
    ];
    for outcome in quiet {
        let clock = FakeClock::auto(T0);
        let pacer = pacer_on(&clock);
        pacer.observe(&outcome);
        assert_eq!(pacer.cooldown_remaining_ms(), 0, "{outcome:?}");
    }
}

#[test]
fn a_cooldown_answers_with_a_synthetic_429() {
    let clock = FakeClock::auto(T0);
    let network = Network::new(&clock, vec![Ok(reply(429, &[("retry-after", "120")]))]);
    let pacer = Arc::new(pacer_on(&clock));
    let archive = Paced::new(&network, pacer.clone());
    runtime().block_on(async {
        let real = archive.fetch(get(CDX)).await.unwrap();
        assert_eq!(real.status, 429);
        clock.advance(1_000);

        // 299 s of the five-minute base left: a 429 that says so, with no
        // body, and no request.
        let synthetic = archive.fetch(get(CDX)).await.unwrap();
        assert_eq!(synthetic.status, 429);
        assert_eq!(synthetic.header("retry-after"), Some("299"));
        assert!(synthetic.body.is_empty());
        assert_eq!(synthetic.final_url, CDX);

        // What the archive client makes of it: throttling with the time
        // left, for the index, and a rate-limited Save Page Now.
        let listed = wayback::list_captures(&archive, APP, None, clock.now()).await;
        assert_eq!(
            listed,
            Err(Unavailable {
                status: 429,
                retry_after_ms: Some(299_000),
                message: "archive.org rate-limited for CDX index — retry after 299s".into(),
            })
        );
        assert_eq!(
            wayback::save_now(&archive, APP).await,
            SaveResult::Failed("Save Page Now rate-limited; retry after 299s".into())
        );

        // Seconds round up: one millisecond left is a Retry-After of 1.
        clock.advance(298_999);
        let last = archive.fetch(get(CDX)).await.unwrap();
        assert_eq!(last.header("retry-after"), Some("1"));
    });
    assert_eq!(
        network.calls().len(),
        1,
        "only the first reached archive.org"
    );
    // The synthetic replies taught the pacer nothing.
    assert_eq!(pacer.consecutive_throttles(), 1);
    assert_eq!(pacer.per_minute(), 5);

    // Once it ends, requests go out again, at the halved rate.
    clock.advance(1);
    runtime().block_on(async {
        archive.fetch(get(CDX)).await.unwrap();
        archive.fetch(get(CDX)).await.unwrap();
    });
    let times = network.times();
    assert_eq!(times[1..], [T0 + 300_000, T0 + 312_000]);
}

#[test]
fn the_state_is_stored_and_reloaded_from_app_settings() {
    let conn = Arc::new(Mutex::new(
        crate::db::open_and_migrate(Path::new(":memory:")).unwrap(),
    ));
    let read = |key: &str| get_setting_with(&conn.lock().unwrap(), key, "").unwrap();
    let store = || Some(Arc::new(SettingsStore::new(&conn)) as Arc<dyn PacerStore>);
    let clock = FakeClock::auto(T0);
    let pacer = Pacer::new(Arc::new(clock.clone()), store());
    // Nothing is written until something changes.
    pacer.observe(&Ok(reply(200, &[])));
    assert_eq!(
        (read(COOLDOWN_KEY), read(STATE_KEY)),
        (String::new(), String::new())
    );

    pacer.observe(&Ok(reply(429, &[("retry-after", "600")])));
    assert_eq!(read(COOLDOWN_KEY), (T0 + 600_000).to_string());
    assert_eq!(
        read(STATE_KEY),
        format!(r#"{{"perMinute":5,"consecutiveThrottles":1,"updatedAt":{T0}}}"#)
    );

    // A success after it resets the count, and writes only the state.
    clock.advance(600_000);
    pacer.observe(&Ok(reply(200, &[])));
    assert_eq!(read(COOLDOWN_KEY), (T0 + 600_000).to_string());
    assert_eq!(
        read(STATE_KEY),
        format!(
            r#"{{"perMinute":5,"consecutiveThrottles":0,"updatedAt":{}}}"#,
            T0 + 600_000
        )
    );

    // A restart in the middle of a cooldown keeps it, the rate and the
    // count, and the count doubles the next one.
    pacer.observe(&Ok(reply(503, &[])));
    let restarted = Pacer::new(Arc::new(FakeClock::auto(T0 + 660_000)), store());
    assert_eq!(restarted.cooldown_remaining_ms(), 240_000);
    assert_eq!(
        (restarted.per_minute(), restarted.consecutive_throttles()),
        (2, 1)
    );
    let network = Network::new(&clock, vec![]);
    let archive = Paced::new(&network, Arc::new(restarted));
    let answer = runtime().block_on(archive.fetch(get(CDX))).unwrap();
    assert_eq!(
        (answer.status, answer.header("retry-after")),
        (429, Some("240"))
    );
    assert!(network.calls().is_empty());

    // What the keys can hold that is not a state: no cooldown, the
    // starting rate, and a rate held to its bounds.
    for (cooldown, state, per_minute) in [
        ("soon", "{", 10),
        ("-5", r#"{"perMinute":"fast"}"#, 10),
        ("", r#"{"perMinute":99,"consecutiveThrottles":-1}"#, 15),
        ("0", r#"{"perMinute":0.5}"#, 2),
        ("", r#"{"perMinute":7.9}"#, 7),
    ] {
        let store = Arc::new(MapStore::with(&[
            (COOLDOWN_KEY, cooldown),
            (STATE_KEY, state),
        ]));
        let pacer = Pacer::new(Arc::new(FakeClock::auto(T0)), Some(store));
        assert_eq!(pacer.cooldown_remaining_ms(), 0, "{cooldown} {state}");
        assert_eq!(pacer.per_minute(), per_minute, "{state}");
        assert_eq!(pacer.consecutive_throttles(), 0, "{state}");
    }

    // Successes that change nothing stored write nothing.
    let store = Arc::new(MapStore::default());
    let pacer = Pacer::new(Arc::new(FakeClock::auto(T0)), Some(store.clone()));
    for _ in 0..19 {
        pacer.observe(&Ok(reply(200, &[])));
    }
    assert_eq!(store.writes(), 0);
    pacer.observe(&Ok(reply(200, &[])));
    assert_eq!(store.writes(), 1, "the twentieth raises the rate");
}

#[test]
fn other_hosts_pass_straight_through() {
    // A manual clock: anything that waited would never finish, and
    // `now_or_never` would say so.
    let clock = FakeClock::manual(T0);
    let pacer = Arc::new(pacer_on(&clock));
    pacer.observe(&Ok(reply(429, &[])));
    let network = Network::new(&clock, vec![Ok(reply(429, &[]))]);
    let archive = Paced::new(&network, pacer.clone());
    for url in [
        APP,
        "https://itunes.apple.com/lookup?id=1",
        "https://archive.org.example.com/x",
        "https://notarchive.org/x",
        "https://developer.example/privacy",
    ] {
        let answer = archive.fetch(get(url)).now_or_never().expect(url).unwrap();
        assert_ne!(answer.header("retry-after"), Some("300"), "{url}");
    }
    assert_eq!(network.calls().len(), 5, "every one reached its host");
    // Apple's 429 is not archive.org's: the cooldown is the one it was.
    assert_eq!(pacer.consecutive_throttles(), 1);
    assert!(clock.slept().is_empty());

    // Every archive host is paced, whatever its spelling.
    for url in [
        "https://archive.org/wayback/available?url=x",
        "https://WEB.archive.org/web/2021id_/x",
        "https://www.web.archive.org./save/x",
    ] {
        let answer = archive.fetch(get(url)).now_or_never().expect(url).unwrap();
        assert_eq!(answer.header("retry-after"), Some("300"), "{url}");
    }
    assert_eq!(network.calls().len(), 5);

    // The pass-through pacer: archive.org at once, back to back, and its
    // 429 starts nothing.
    let unpaced = Arc::new(Pacer::unpaced());
    let network = Network::new(&clock, vec![Ok(reply(429, &[]))]);
    let archive = Paced::new(&network, unpaced.clone());
    for _ in 0..3 {
        archive.fetch(get(CDX)).now_or_never().unwrap().unwrap();
    }
    assert_eq!(network.calls().len(), 3);
    assert_eq!(unpaced.admit().now_or_never(), Some(Admission::Go));
    assert_eq!(unpaced.cooldown_remaining_ms(), 0);
}

#[test]
fn two_callers_take_turns() {
    let clock = FakeClock::manual(T0);
    let pacer = Arc::new(pacer_on(&clock));
    let granted: Arc<Mutex<Vec<(&str, i64)>>> = Arc::default();
    runtime().block_on(async {
        assert_eq!(pacer.admit().now_or_never(), Some(Admission::Go));
        let caller = |name: &'static str| {
            let (pacer, clock, granted) = (pacer.clone(), clock.clone(), granted.clone());
            tokio::spawn(async move {
                assert_eq!(pacer.admit().await, Admission::Go);
                granted.lock().unwrap().push((name, clock.now()));
            })
        };
        // A bulk run's request and then a click, both before the next slot.
        let bulk = caller("bulk");
        settle().await;
        let click = caller("click");
        settle().await;
        assert!(granted.lock().unwrap().is_empty());
        clock.advance(6_000);
        settle().await;
        assert_eq!(*granted.lock().unwrap(), [("bulk", T0 + 6_000)]);
        clock.advance(5_999);
        settle().await;
        assert_eq!(granted.lock().unwrap().len(), 1);
        clock.advance(1);
        settle().await;
        bulk.await.unwrap();
        click.await.unwrap();
    });
    assert_eq!(
        *granted.lock().unwrap(),
        [("bulk", T0 + 6_000), ("click", T0 + 12_000)]
    );
}

#[test]
fn a_dropped_wait_gives_its_turn_back() {
    let clock = FakeClock::manual(T0);
    let pacer = Arc::new(pacer_on(&clock));
    let granted: Arc<Mutex<Vec<i64>>> = Arc::default();
    runtime().block_on(async {
        assert_eq!(pacer.admit().now_or_never(), Some(Admission::Go));
        clock.advance(1_000);
        // Waiting for its slot at T0 + 6 s, and dropped.
        assert_eq!(pacer.admit().now_or_never(), None);
        // Queued behind a waiter, and dropped.
        let head = {
            let (pacer, clock, granted) = (pacer.clone(), clock.clone(), granted.clone());
            tokio::spawn(async move {
                pacer.admit().await;
                granted.lock().unwrap().push(clock.now());
            })
        };
        settle().await;
        let queued = {
            let pacer = pacer.clone();
            tokio::spawn(async move { pacer.admit().await })
        };
        settle().await;
        queued.abort();
        settle().await;
        // The live waiter takes the slot the first one gave back...
        clock.advance(5_000);
        settle().await;
        head.await.unwrap();
        // ...and the next caller's turn is one slot after it, not two.
        let next = {
            let (pacer, clock, granted) = (pacer.clone(), clock.clone(), granted.clone());
            tokio::spawn(async move {
                pacer.admit().await;
                granted.lock().unwrap().push(clock.now());
            })
        };
        settle().await;
        clock.advance(6_000);
        settle().await;
        next.await.unwrap();
    });
    assert_eq!(*granted.lock().unwrap(), [T0 + 6_000, T0 + 12_000]);
}

#[test]
fn the_registry_gives_each_server_its_pacer_and_a_replay_none() {
    let conn = Mutex::new(Connection::open_in_memory().unwrap());
    let other = Mutex::new(Connection::open_in_memory().unwrap());
    let clock = FakeClock::auto(T0);
    let network = Network::new(&clock, vec![Ok(reply(503, &[]))]);
    let mut db = Locked {
        conn: &conn,
        log: None,
        on_wait: None,
    };
    assert!(!for_connection(&conn.lock().unwrap()).is_paced());
    // Unregistered: the requests go straight out and teach nothing.
    let archive = paced(&mut db, &network);
    runtime().block_on(async {
        archive.fetch(get(CDX)).await.unwrap();
        archive.fetch(get(CDX)).await.unwrap();
    });
    assert_eq!(network.times(), [T0, T0]);

    let pacer = Arc::new(pacer_on(&clock));
    let registration = register(&conn.lock().unwrap(), pacer.clone());
    assert!(Arc::ptr_eq(&for_connection(&conn.lock().unwrap()), &pacer));
    assert!(!for_connection(&other.lock().unwrap()).is_paced());
    // Registered: found through a section, and paced.
    let network = Network::new(&clock, vec![Ok(reply(503, &[]))]);
    let archive = paced(&mut db, &network);
    let second = runtime().block_on(async {
        archive.fetch(get(CDX)).await.unwrap();
        archive.fetch(get(CDX)).await.unwrap()
    });
    assert_eq!((second.status, network.calls().len()), (429, 1));
    assert_eq!(pacer.consecutive_throttles(), 1);

    drop(registration);
    assert!(!for_connection(&conn.lock().unwrap()).is_paced());
}

#[test]
fn a_spawned_run_keeps_the_pacer() {
    let clock = FakeClock::auto(T0);
    let pacer = Arc::new(pacer_on(&clock));
    let network = Network::new(&clock, vec![Ok(reply(429, &[]))]);
    let archive = Paced::new(&network, pacer.clone());
    let owned = archive.shared().expect("the network can be shared");
    let first = runtime().block_on(owned.fetch(get(CDX))).unwrap();
    assert_eq!(first.status, 429);
    // The request's own handle sees the cooldown the spawned run started.
    let second = runtime().block_on(archive.fetch(get(CDX))).unwrap();
    assert_eq!(
        (second.header("retry-after"), network.calls().len()),
        (Some("300"), 1)
    );

    let mut local = Network::new(&clock, vec![]);
    local.shareable = false;
    assert!(Paced::new(&local, pacer).shared().is_none());
}
