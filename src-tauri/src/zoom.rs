// Webview page zoom — the desktop counterpart of browser Cmd/Ctrl+± zoom.
//
// WCAG 1.4.4 requires text to be resizable to 200% without assistive
// tech. In the browser deployment the user agent provides that (Cmd/Ctrl
// + ± full-page zoom), but a Tauri webview ships with no zoom UI at all,
// and the in-app text-size ladder (html[data-a11y-scale], CSS `zoom` on
// .app-main) deliberately stops at 1.3× because CSS zoom doesn't shrink
// the layout viewport — responsive breakpoints never engage, so large
// factors trap content horizontally. `WebviewWindow::set_zoom` is real
// page zoom (WKWebView pageZoom / WebView2 ZoomFactor / webkit2gtk
// zoom-level): text, spacing AND the layout viewport scale together, so
// the web app's existing reflow handling applies exactly as it does
// under browser zoom.
//
// Driven by the View-menu items in app_menu.rs (Actual Size ⌘0 /
// Zoom In ⌘= / Zoom Out ⌘−). The level persists as `zoom_level` in the
// /api/settings/desktop bundle — same round-trip as `devtools_open` —
// and main.rs::setup calls `init` with the persisted value so the
// chosen zoom survives quit/relaunch.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

/// Browser-style zoom ladder. The 3.0 ceiling is deliberate: the main
/// window's minWidth is 960 (tauri.conf.json), and page zoom divides the
/// CSS layout viewport by the factor — 960 / 3.0 = 320 CSS px, exactly
/// the reflow floor WCAG 1.4.10 requires the layout to support. Going
/// higher would push the narrowest window below the breakpoints the web
/// app is built to handle.
const ZOOM_LADDER: &[f64] = &[
    0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
];

/// Current level. A plain static (not Tauri managed state) because the
/// menu handlers are generic over `Runtime` and there's exactly one
/// main window — same rationale as the `STATE` OnceCell in main.rs.
static CURRENT: Mutex<f64> = Mutex::new(1.0);

/// Bumped on every level change; the debounced persist thread only
/// POSTs if its generation is still current after the quiet period, so
/// holding ⌘= doesn't burn the settings route's 20/min rate limit.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Clamp an arbitrary (possibly hand-edited or corrupted) persisted
/// value into the ladder's range. Non-finite input falls back to 1.0.
pub fn clamp(level: f64) -> f64 {
    if !level.is_finite() {
        return 1.0;
    }
    level.clamp(ZOOM_LADDER[0], ZOOM_LADDER[ZOOM_LADDER.len() - 1])
}

/// Pure step logic: snap `current` to the nearest ladder rung, then move
/// one rung in `direction` (clamped at both ends). Split out from the
/// AppHandle plumbing so it can be unit-tested.
fn next_level(current: f64, direction: isize) -> f64 {
    let current = clamp(current);
    let mut closest = 0usize;
    let mut best = f64::MAX;
    for (i, &rung) in ZOOM_LADDER.iter().enumerate() {
        let d = (rung - current).abs();
        if d < best {
            best = d;
            closest = i;
        }
    }
    let next = (closest as isize + direction).clamp(0, ZOOM_LADDER.len() as isize - 1) as usize;
    ZOOM_LADDER[next]
}

/// Restore the persisted level at boot. Skips the set_zoom call at 1.0
/// so a default install never touches the webview zoom API at all.
pub fn init<R: Runtime>(app: &AppHandle<R>, level: f64) {
    let level = clamp(level);
    *CURRENT.lock().expect("zoom level mutex") = level;
    if (level - 1.0).abs() > 0.001 {
        apply(app, level);
        log::info!("restored webview zoom level {level}");
    }
}

pub fn zoom_in<R: Runtime>(app: &AppHandle<R>) {
    step(app, 1);
}

pub fn zoom_out<R: Runtime>(app: &AppHandle<R>) {
    step(app, -1);
}

pub fn reset<R: Runtime>(app: &AppHandle<R>) {
    set(app, 1.0);
}

fn step<R: Runtime>(app: &AppHandle<R>, direction: isize) {
    let current = *CURRENT.lock().expect("zoom level mutex");
    set(app, next_level(current, direction));
}

fn set<R: Runtime>(app: &AppHandle<R>, level: f64) {
    let level = clamp(level);
    {
        let mut current = CURRENT.lock().expect("zoom level mutex");
        if (*current - level).abs() < 0.001 {
            // Already there (e.g. ⌘= at the top of the ladder) — don't
            // re-apply or re-persist a no-op.
            return;
        }
        *current = level;
    }
    apply(app, level);
    persist_debounced(level);
}

fn apply<R: Runtime>(app: &AppHandle<R>, level: f64) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(e) = window.set_zoom(level) {
            log::warn!("set_zoom({level}) failed: {e}");
        }
    }
}

/// Fire-and-forget persist with an 800ms quiet period: repeated steps
/// while the user holds the accelerator collapse into one POST carrying
/// the final level. Mirrors commands::persist_devtools_open otherwise.
fn persist_debounced(level: f64) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let base_url = crate::state().sidecar_base_url.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let url = format!("{base_url}/api/settings/desktop");
        let body = format!("{{\"zoom_level\":{level}}}");
        match ureq::post(&url)
            .timeout(Duration::from_secs(3))
            .set("content-type", "application/json")
            .send_string(&body)
        {
            Ok(_) => log::info!("persisted zoom_level={level}"),
            Err(e) => log::warn!("failed to persist zoom_level={level}: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ladder_reaches_double_size_for_wcag_1_4_4() {
        // The whole point of this module: 200% must be reachable.
        assert!(ZOOM_LADDER.contains(&2.0));
    }

    #[test]
    fn steps_walk_the_ladder_from_default() {
        assert_eq!(next_level(1.0, 1), 1.1);
        assert_eq!(next_level(1.0, -1), 0.9);
    }

    #[test]
    fn steps_clamp_at_both_ends() {
        assert_eq!(next_level(3.0, 1), 3.0);
        assert_eq!(next_level(0.5, -1), 0.5);
    }

    #[test]
    fn off_ladder_values_snap_to_nearest_rung_before_stepping() {
        // A hand-edited 1.3 snaps to 1.25, then steps to 1.5.
        assert_eq!(next_level(1.3, 1), 1.5);
    }

    #[test]
    fn clamp_handles_garbage_persisted_values() {
        // Non-finite input is garbage, not "very large" — fall back to
        // the 1.0 default rather than pinning the window at max zoom.
        assert_eq!(clamp(f64::NAN), 1.0);
        assert_eq!(clamp(f64::INFINITY), 1.0);
        assert_eq!(clamp(0.0), 0.5);
        assert_eq!(clamp(99.0), 3.0);
        assert_eq!(clamp(1.5), 1.5);
    }
}
