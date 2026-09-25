//! `lib/live-bulk-runs.ts`: the bulk runs executing on a server right now,
//! so a boot-time resume check never takes over a run its own server
//! started after boot. From the database such a run looks exactly like one
//! a crash left behind, a blob with pending work and a held mutex; without
//! this, a run started in the first seconds after boot was resumed by its
//! own server: a second runner on the same queue, a "resumed after server
//! restart" notification with no restart, and every pending app fetched
//! twice.
//!
//! Node keeps one registry per process on `globalThis`, and one Node
//! process serves one database. A Rust process can hold several servers
//! (the test binaries run many at once), so a run is registered against
//! its server's connection, which every section reaches through
//! `Writer::conn`: one per server, behind the one mutex, at one address for
//! as long as any run on it lives. The entry goes when the run's
//! [`LiveRun`] drops, whether the run returns, fails, panics or is dropped
//! with its runtime, so no entry outlives its run and a later connection
//! at the same address starts clean.

use rusqlite::Connection;
use std::sync::{Mutex, PoisonError};

/// The bulk jobs with a boot-time resume check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Job {
    Policy,
    Sync,
    Wayback,
}

/// One entry per live run, so an overlapping run of the same job keeps the
/// job live until the last one ends, as Node's count does.
static LIVE: Mutex<Vec<(usize, Job)>> = Mutex::new(Vec::new());

fn server(conn: &Connection) -> usize {
    std::ptr::from_ref(conn).addr()
}

/// A run, live until this drops.
#[must_use = "the run is live only while this is held"]
pub(crate) struct LiveRun {
    entry: (usize, Job),
}

impl Drop for LiveRun {
    fn drop(&mut self) {
        // A poisoned lock is still read: a drop while unwinding must not
        // panic again.
        let mut live = LIVE.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(at) = live.iter().position(|entry| *entry == self.entry) {
            live.swap_remove(at);
        }
    }
}

/// `withLiveBulkRun`: the run of `job` on this connection's server is live
/// until the returned guard drops.
pub(crate) fn enter(conn: &Connection, job: Job) -> LiveRun {
    let entry = (server(conn), job);
    LIVE.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(entry);
    LiveRun { entry }
}

/// `isBulkRunLive`: is a `job` runner executing on this connection's
/// server?
pub(crate) fn is_live(conn: &Connection, job: Job) -> bool {
    let entry = (server(conn), job);
    LIVE.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains(&entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_is_live_until_its_guard_drops() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(!is_live(&conn, Job::Sync));
        let run = enter(&conn, Job::Sync);
        assert!(is_live(&conn, Job::Sync));
        assert!(!is_live(&conn, Job::Policy), "only the job that runs");
        drop(run);
        assert!(!is_live(&conn, Job::Sync));
    }

    #[test]
    fn overlapping_runs_keep_the_job_live_until_the_last_ends() {
        let conn = Connection::open_in_memory().unwrap();
        let first = enter(&conn, Job::Wayback);
        let second = enter(&conn, Job::Wayback);
        drop(first);
        assert!(is_live(&conn, Job::Wayback));
        drop(second);
        assert!(!is_live(&conn, Job::Wayback));
    }

    #[test]
    fn a_run_is_live_on_its_own_server_only() {
        let one = Connection::open_in_memory().unwrap();
        let other = Connection::open_in_memory().unwrap();
        let _run = enter(&one, Job::Policy);
        assert!(is_live(&one, Job::Policy));
        assert!(!is_live(&other, Job::Policy));
    }

    #[test]
    fn a_run_that_panics_is_not_left_live() {
        let conn = Connection::open_in_memory().unwrap();
        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _run = enter(&conn, Job::Sync);
            panic!("the run failed");
        }));
        assert!(unwound.is_err());
        assert!(!is_live(&conn, Job::Sync));
    }
}
