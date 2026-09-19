//! The process-local CSP report ring: the POST's bounded writer (newest
//! first, fifty kept) and the GET's ordered report list.
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};

fn ring() -> &'static Mutex<Vec<Value>> {
    static RING: OnceLock<Mutex<Vec<Value>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(Vec::new()))
}
const RING_MAX: usize = 50;

pub(super) fn read() -> Value {
    json!({"reports":*super::lifecycle::lock_state(ring())})
}

/// `ring.unshift(report)` then the cap.
pub(super) fn push(report: Value) {
    let mut ring = super::lifecycle::lock_state(ring());
    ring.insert(0, report);
    ring.truncate(RING_MAX);
}
#[cfg(test)]
pub(super) fn replace_for_test(reports: Vec<Value>) {
    *ring().lock().unwrap() = reports;
}
