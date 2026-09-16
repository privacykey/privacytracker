//! The process-local CSP report ring. Phase 4 will attach its bounded POST
//! writer; GET can already expose the same ordered report list.
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};

fn ring() -> &'static Mutex<Vec<Value>> {
    static RING: OnceLock<Mutex<Vec<Value>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(Vec::new()))
}
pub(super) fn read() -> Value {
    json!({"reports":*ring().lock().expect("CSP ring mutex")})
}
#[cfg(test)]
pub(super) fn replace_for_test(reports: Vec<Value>) {
    *ring().lock().unwrap() = reports;
}
