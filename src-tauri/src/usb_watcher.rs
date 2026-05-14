// IOKit USB device-attach watcher. Replaces the previous 5s-poll loop in
// `DeviceConnectedToast` with an event-driven path:
//
//   * On app startup we spawn a dedicated thread that owns a
//     `CFRunLoop` + `IONotificationPort`.
//   * The port subscribes to `kIOFirstMatchNotification` for the
//     `IOUSBDevice` class. Apple devices in MFI/USB mode (iPhone, iPad,
//     iPod) attach via usbmuxd which still surfaces as IOUSBDevice in
//     IOKit, so the same hook covers all of them.
//   * When devices appear we drain the iterator (required to keep
//     receiving future notifications) and ask cfgutil for the current
//     attached set via the cached `list_connected_devices_impl`. Any
//     device we haven't seen this session is emitted as a Tauri event
//     `cfgutil:device-connected` to the webview.
//
// The watcher is gated by the webview side: the `DeviceConnectedToast`
// only subscribes to the event when the user has previously imported via
// cfgutil (`cfgutil_imported_at` set). The watcher itself, however, runs
// unconditionally on macOS — IOKit notifications are cheap. The
// expensive part is calling cfgutil, which only happens on actual USB
// attach events.
//
// Non-macOS builds compile to a no-op `start` function.

#![allow(dead_code)] // non-macOS no-op stubs would otherwise warn.

#[cfg(target_os = "macos")]
use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::os::raw::c_void;
#[cfg(target_os = "macos")]
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::thread;

#[cfg(target_os = "macos")]
use core_foundation::base::TCFType;
#[cfg(target_os = "macos")]
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop, CFRunLoopSource};
#[cfg(target_os = "macos")]
use io_kit_sys::{
    kIOMasterPortDefault, IOIteratorNext, IONotificationPortCreate,
    IONotificationPortGetRunLoopSource, IOObjectRelease, IOServiceAddMatchingNotification,
    IOServiceMatching,
};
#[cfg(target_os = "macos")]
use io_kit_sys::keys::kIOFirstMatchNotification;
#[cfg(target_os = "macos")]
use io_kit_sys::types::io_iterator_t;

#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter};

use serde::Serialize;

#[cfg(target_os = "macos")]
use crate::cfgutil;

/// Payload shape emitted with `cfgutil:device-connected`. Matches
/// `ConnectedDevice` in `cfgutil.rs` so the webview side can treat the
/// event payload identically to a `list_connected_devices` row.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConnectedPayload {
    pub ecid: String,
    pub name: Option<String>,
    pub model: Option<String>,
    pub ios_version: Option<String>,
    pub device_class: Option<String>,
}

#[cfg(target_os = "macos")]
struct WatcherContext {
    app: AppHandle,
    seen: Mutex<HashSet<String>>,
}

/// Kick off the watcher on app startup. Idempotent guard — wiring this
/// in `main.rs` `.setup()` is sufficient.
#[cfg(target_os = "macos")]
pub fn start(app: AppHandle) {
    thread::Builder::new()
        .name("privacytracker-usb-watcher".into())
        .spawn(move || {
            if let Err(err) = run_loop(app) {
                log::warn!("usb_watcher: terminated early: {err}");
            }
        })
        .ok();
}

#[cfg(not(target_os = "macos"))]
pub fn start(_app: tauri::AppHandle) {
    // No iOS/iPadOS devices to detect outside macOS.
}

#[cfg(target_os = "macos")]
fn run_loop(app: AppHandle) -> Result<(), String> {
    // Leak the context box on purpose — the C callback dereferences it
    // for the lifetime of the run loop, which lives for the lifetime of
    // the app. Dropping it would dangle the pointer across reentry.
    let ctx = Box::leak(Box::new(WatcherContext {
        app,
        seen: Mutex::new(HashSet::new()),
    })) as *mut WatcherContext as *mut c_void;

    unsafe {
        let port = IONotificationPortCreate(kIOMasterPortDefault);
        if port.is_null() {
            return Err("IONotificationPortCreate returned null".to_string());
        }

        // Match every USB device. Filtering by vendor/product id (Apple
        // is 0x05ac) would be tighter, but Apple ships a handful of
        // peripherals on different ids; cfgutil's own enumerate handles
        // the "is this an iOS device?" decision authoritatively, so we
        // pass the broader filter and let cfgutil's list result trim.
        let matching = IOServiceMatching(b"IOUSBDevice\0".as_ptr() as *const _);
        if matching.is_null() {
            return Err("IOServiceMatching returned null".to_string());
        }

        let mut iter: io_iterator_t = 0;
        let kr = IOServiceAddMatchingNotification(
            port,
            kIOFirstMatchNotification as *mut _,
            matching,
            device_appeared,
            ctx,
            &mut iter,
        );
        if kr != 0 {
            return Err(format!("IOServiceAddMatchingNotification failed: 0x{kr:x}"));
        }

        // Drain the initial iterator. IOKit requires the iterator to be
        // walked at registration time, otherwise no future notifications
        // are delivered. We also pass the already-connected devices
        // through `device_appeared` so the toast can fire if a phone
        // was already plugged in when the app launched.
        device_appeared(ctx, iter);

        // Wire the port into THIS thread's run loop. The CFRunLoop call
        // below blocks; the run loop only returns when we tell it to or
        // the process exits.
        let source_ref = IONotificationPortGetRunLoopSource(port);
        if source_ref.is_null() {
            return Err("IONotificationPortGetRunLoopSource returned null".to_string());
        }
        let source = CFRunLoopSource::wrap_under_get_rule(source_ref);
        let run_loop = CFRunLoop::get_current();
        run_loop.add_source(&source, kCFRunLoopDefaultMode);

        CFRunLoop::run_current();
    }

    Ok(())
}

/// IOKit C callback. Drains the iterator + asks cfgutil for the current
/// device set; for each ECID we haven't seen, emit a Tauri event.
#[cfg(target_os = "macos")]
unsafe extern "C" fn device_appeared(refcon: *mut c_void, iterator: io_iterator_t) {
    // Safety: refcon points to a leaked `WatcherContext` — see `run_loop`.
    let ctx = unsafe { &*(refcon as *const WatcherContext) };

    // Drain the iterator. We don't use the io_service_t handles
    // ourselves — cfgutil owns the device-listing logic — but the
    // drain is mandatory to keep IOKit delivering future events.
    unsafe {
        loop {
            let service = IOIteratorNext(iterator);
            if service == 0 {
                break;
            }
            IOObjectRelease(service);
        }
    }

    // cfgutil-backed enumerate. cached_detect_cfgutil + the two
    // cfgutil shell-outs run on this watcher thread, not the Tauri
    // runtime — the IPC stays unblocked even on a cold first call.
    let list = cfgutil::list_connected_devices_for_watcher();
    if list.cfgutil_unavailable {
        return;
    }

    let mut seen = match ctx.seen.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(), // poisoned — recover and carry on
    };

    for device in list.devices {
        if device.ecid.is_empty() {
            continue;
        }
        if !seen.insert(device.ecid.clone()) {
            continue; // already announced this session
        }
        let payload = DeviceConnectedPayload {
            ecid: device.ecid,
            name: device.name,
            model: device.model,
            ios_version: device.ios_version,
            device_class: device.device_class,
        };
        if let Err(err) = ctx.app.emit("cfgutil:device-connected", payload) {
            log::warn!("usb_watcher: emit cfgutil:device-connected failed: {err}");
        }
    }
}
