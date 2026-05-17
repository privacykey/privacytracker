// macOS-only Touch ID / device-password gate.
//
// Wraps Apple's LocalAuthentication.framework (LAContext). We ask the
// system to evaluate `.deviceOwnerAuthentication` — which falls back
// to the user's macOS login password on a Mac without a Touch ID
// sensor, or when the sensor isn't available (e.g. the user plugged
// in an external display and closed the lid). This is exactly the
// behaviour the user expects from "require authentication" on a
// sensitive-app level: Touch ID first, password fallback.
//
// IMPORTANT: This is scoped strictly to GATING UI ACCESS (unlocking the
// main window). It is never used to derive keys for backup encryption.
// The rationale: backups need to import cleanly on the web build and
// across machines, so any future encrypted-backup format must use a
// portable, passphrase-derived key (AES-GCM + PBKDF2/Argon2) rather
// than tying itself to a Secure Enclave key that can't leave this Mac.

use std::sync::mpsc;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
// objc2 0.6 deprecated `msg_send_id!` — plain `msg_send!` now performs
// the conversion to/from `Retained` automatically, so we drop the
// import. ClassType still comes from objc2's prelude; the trait
// identity matters here because LAContext's `class()` method is
// implemented on 0.6's ClassType, and importing 0.5's by mistake (via
// stale objc2-local-authentication 0.2) was the original cause of the
// "no function named class" + "Message is not implemented" cascade.
use objc2::{msg_send, ClassType};
use objc2_foundation::{NSError, NSString};
use objc2_local_authentication::{LAContext, LAPolicy};

/// Prompt for Touch ID / password with the given reason string. Blocks
/// the calling thread for up to `timeout` waiting for user response.
/// Returns Ok(true) on successful authentication, Ok(false) on user
/// cancel, and Err(msg) if the system refused to present the prompt at
/// all (e.g. no biometrics set up and no password).
///
/// The reason string is shown verbatim in the Touch ID prompt below
/// "privacytracker is trying to…". Keep it user-facing: "unlock
/// privacytracker".
pub fn prompt(reason: &str, timeout: Duration) -> Result<bool, String> {
    unsafe {
        // objc2 0.6: `msg_send!` returns `Retained<T>` when the LHS
        // ascribes a `Retained<T>` type (was previously `msg_send_id!`).
        let context: Retained<LAContext> = msg_send![LAContext::class(), new];

        // Pre-flight: canEvaluatePolicy returns false if no biometrics are
        // enrolled *and* no password is set. In that case, tell the caller
        // so it can either skip the lock (best-effort) or surface a
        // "Touch ID isn't set up" error in the UI.
        let mut preflight_err: *mut NSError = std::ptr::null_mut();
        let can_evaluate: Bool = msg_send![
            &*context,
            canEvaluatePolicy: LAPolicy::DeviceOwnerAuthentication,
            error: &mut preflight_err
        ];
        if !can_evaluate.as_bool() {
            // canEvaluatePolicy returns an autoreleased NSError via the
            // out-param. Convert the raw `*mut NSError` to an owned
            // `Retained<NSError>` via `Retained::retain` rather than
            // dereferencing it directly. `retain` is the documented
            // objc2 path for taking ownership of an Objective-C return
            // through a raw pointer: it folds the null check into the
            // `Option`, bumps the retain count to give us stable
            // ownership for the duration of the message-send, and
            // lifts the pointer into Rust's lifetime tracking — so we
            // never expose a raw-pointer dereference to the rest of
            // the function. CodeQL's `rust/access-invalid-pointer`
            // rule flagged the previous `&*preflight_err` form.
            let msg = match Retained::retain(preflight_err) {
                None => "LAContext can't evaluate authentication (no Touch ID or password set up)".to_string(),
                Some(err) => {
                    let s: Retained<NSString> = msg_send![&*err, localizedDescription];
                    s.to_string()
                }
            };
            return Err(msg);
        }

        // evaluatePolicy is async — it calls the reply block when the user
        // finishes (Touch ID success, password success, cancel, or timeout).
        // Bridge that into a sync call via an mpsc channel + recv_timeout.
        let (tx, rx) = mpsc::channel::<bool>();
        let reason_ns = NSString::from_str(reason);

        let block = block2::RcBlock::new(move |success: Bool, _err: *mut NSError| {
            let _ = tx.send(success.as_bool());
        });

        let _: () = msg_send![
            &*context,
            evaluatePolicy: LAPolicy::DeviceOwnerAuthentication,
            localizedReason: &*reason_ns,
            reply: &*block
        ];

        match rx.recv_timeout(timeout) {
            Ok(success) => Ok(success),
            Err(_) => {
                // Best-effort: tell LAContext to invalidate so the reply
                // block doesn't fire after we've already given up and
                // write to a dropped sender.
                let _: () = msg_send![&*context, invalidate];
                Err("Touch ID prompt timed out".to_string())
            }
        }
    }
}

// Silence unused-import warnings when the AnyObject alias isn't needed.
#[allow(dead_code)]
type _Unused = AnyObject;
