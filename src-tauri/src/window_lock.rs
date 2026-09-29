// One gate for every reveal of the main window.
//
// "Require Touch ID / password to open the window" (desktop_require_unlock)
// only means something if nothing can put the window on screen without
// asking. So every path that shows it comes through `reveal` here: the boot
// path, the tray, the global shortcut, deep links, the menu bar and the
// `reveal_main_window` command. When the setting is on and the window is
// locked, `reveal` asks for Touch ID or the login password first and shows
// the window only if that succeeds.
//
// The unlocked state lives in this process only. Hiding the window, whether
// by the close button, "Hide to Menu Bar", the tray or auto-lock, locks it
// again, and so does quitting.
//
// Auto-lock (desktop_auto_lock_idle_minutes, 0 = off) hides and locks the
// window once it has gone that long without use: without keyboard or mouse
// input while it is the focused window, or without being the focused window
// at all.
//
// The setting is read from the backend on every reveal, so turning it on in
// Settings applies the next time the window opens, with no restart. If that
// read fails, the last value read is kept.
//
// The page itself is not granted the window's show/hide permissions
// (capabilities/main.json), and the window-state plugin does not restore
// visibility (main.rs), so neither can put the window up around this gate.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use once_cell::sync::OnceCell;
use tauri::{AppHandle, Manager, Runtime};

const MAIN_WINDOW: &str = "main";

/// Shown by macOS as "privacytracker is trying to unlock its window."
#[cfg(target_os = "macos")]
const PROMPT_REASON: &str = "unlock its window";
#[cfg(target_os = "macos")]
const PROMPT_TIMEOUT: Duration = Duration::from_secs(60);

/// How often the auto-lock timer looks at the window.
const AUTO_LOCK_TICK: Duration = Duration::from_secs(15);
/// How often, while the window is open, the timer re-reads the lock
/// settings, so a change made in Settings reaches a window that is
/// already open.
const POLICY_REFRESH_TICKS: u32 = 4;

/// What a request to show the window should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reveal {
    /// Show it now: no unlock is required, or it is already unlocked.
    Show,
    /// Ask for Touch ID / password, then show it if that succeeds.
    Prompt,
    /// A prompt is already on screen; this request waits on that one.
    Pending,
    /// Locked, and the caller asked not to prompt.
    Refused,
}

/// The gate's state. Kept free of Tauri types so the rules can be tested.
#[derive(Debug)]
pub(crate) struct Lock {
    require_unlock: bool,
    auto_lock_minutes: u32,
    /// True from the moment the gate lets the window open until it is
    /// hidden again. This is the "unlocked" flag: while it is set, a reveal
    /// needs no prompt.
    open: bool,
    /// A Touch ID / password prompt is on screen.
    prompting: bool,
    /// When the window was last in use, for auto-lock.
    last_active: Option<Instant>,
}

impl Lock {
    pub(crate) const fn new() -> Self {
        Self {
            require_unlock: false,
            auto_lock_minutes: 0,
            open: false,
            prompting: false,
            last_active: None,
        }
    }

    pub(crate) fn set_policy(&mut self, require_unlock: bool, auto_lock_minutes: u32) {
        self.require_unlock = require_unlock;
        self.auto_lock_minutes = auto_lock_minutes;
    }

    pub(crate) fn is_open(&self) -> bool {
        self.open
    }

    /// Decide what a reveal request does. `Show` also marks the window
    /// open, and `Prompt` marks a prompt as started, in the same step, so
    /// two requests racing each other cannot both prompt.
    pub(crate) fn request_reveal(&mut self, allow_prompt: bool, now: Instant) -> Reveal {
        if !self.require_unlock || self.open {
            self.mark_open(now);
            return Reveal::Show;
        }
        if self.prompting {
            return Reveal::Pending;
        }
        if !allow_prompt {
            return Reveal::Refused;
        }
        self.prompting = true;
        Reveal::Prompt
    }

    /// Record how the prompt ended. Returns whether to show the window.
    pub(crate) fn prompt_finished(&mut self, unlocked: bool, now: Instant) -> bool {
        self.prompting = false;
        if unlocked {
            self.mark_open(now);
        }
        unlocked
    }

    /// The window was hidden: lock it again.
    pub(crate) fn closed(&mut self) {
        self.open = false;
        self.last_active = None;
    }

    /// The window gained or lost focus.
    pub(crate) fn note_activity(&mut self, now: Instant) {
        if self.open {
            self.last_active = Some(now);
        }
    }

    /// Fold in what the timer saw: while the window is focused, the last
    /// keyboard or mouse input anywhere counts as use of it. Without that
    /// reading (non-macOS), being focused counts as use.
    pub(crate) fn observe(&mut self, now: Instant, focused: bool, system_idle: Option<Duration>) {
        if !(self.open && focused) {
            return;
        }
        let seen = match system_idle {
            Some(idle) => match now.checked_sub(idle) {
                Some(at) => at,
                None => return,
            },
            None => now,
        };
        if self.last_active.map_or(true, |last| seen > last) {
            self.last_active = Some(seen);
        }
    }

    /// Whether auto-lock should hide the window now.
    pub(crate) fn auto_lock_due(&self, now: Instant) -> bool {
        if !(self.require_unlock && self.open && self.auto_lock_minutes > 0) {
            return false;
        }
        let Some(last) = self.last_active else {
            return false;
        };
        now.saturating_duration_since(last)
            >= Duration::from_secs(u64::from(self.auto_lock_minutes) * 60)
    }

    fn mark_open(&mut self, now: Instant) {
        if !self.open {
            self.open = true;
            self.last_active = Some(now);
        }
    }
}

static LOCK: Mutex<Lock> = Mutex::new(Lock::new());
static ON_OPEN_CHANGED: OnceCell<Box<dyn Fn(bool) + Send + Sync>> = OnceCell::new();

fn lock() -> MutexGuard<'static, Lock> {
    // A panic while holding the lock leaves plain data behind; keep going.
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Seed the gate with the settings read at boot.
pub fn init(require_unlock: bool, auto_lock_minutes: u32) {
    lock().set_policy(require_unlock, auto_lock_minutes);
}

/// Called with `true` when the gate opens the window and `false` when it
/// hides it. The tray uses this to keep its Show / Hide label right.
pub fn on_open_changed(callback: impl Fn(bool) + Send + Sync + 'static) {
    let _ = ON_OPEN_CHANGED.set(Box::new(callback));
}

/// Whether the window is open (shown through the gate and not hidden since).
pub fn is_open() -> bool {
    lock().is_open()
}

/// Show the main window, asking for Touch ID / password first when the
/// setting is on and the window is locked. Returns at once: the work runs
/// on its own thread so a prompt never blocks the caller (often the main
/// thread).
pub fn reveal<R: Runtime>(app: &AppHandle<R>) {
    request(app, true);
}

/// Show the main window only if no prompt is needed. For the tray icon
/// click, which also opens the tray menu: a locked window stays hidden
/// there, and the menu's "Show privacytracker" asks to unlock.
pub fn reveal_if_unlocked<R: Runtime>(app: &AppHandle<R>) {
    request(app, false);
}

/// Hide the main window and lock it.
pub fn hide<R: Runtime, M: Manager<R>>(manager: &M) {
    // Lock first: a reveal that lands between the two steps then prompts
    // rather than finding the window still marked open.
    lock().closed();
    if let Some(window) = manager.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
    notify(false);
}

/// The main window gained or lost focus.
pub fn note_activity() {
    lock().note_activity(Instant::now());
}

/// Start the auto-lock timer.
pub fn spawn_auto_lock<R: Runtime>(app: AppHandle<R>) {
    let spawned = std::thread::Builder::new()
        .name("window-auto-lock".into())
        .spawn(move || {
            let mut ticks_open = 0u32;
            loop {
                std::thread::sleep(AUTO_LOCK_TICK);
                if !is_open() {
                    ticks_open = 0;
                    continue;
                }
                if ticks_open % POLICY_REFRESH_TICKS == 0 {
                    refresh_policy();
                }
                ticks_open = ticks_open.wrapping_add(1);
                let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
                    continue;
                };
                let focused = window.is_focused().unwrap_or(false);
                let idle = system_idle();
                let now = Instant::now();
                let due = {
                    let mut state = lock();
                    state.observe(now, focused, idle);
                    state.auto_lock_due(now)
                };
                if due {
                    log::info!("window lock: no activity for the auto-lock time, locking");
                    hide(&app);
                }
            }
        });
    if let Err(e) = spawned {
        log::warn!("window lock: couldn't start the auto-lock timer: {e}");
    }
}

fn request<R: Runtime>(app: &AppHandle<R>, allow_prompt: bool) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("window-reveal".into())
        .spawn(move || {
            refresh_policy();
            // Bound first: a guard in the match scrutinee would be held
            // through the prompt, and the prompt arm takes the lock again.
            let decision = lock().request_reveal(allow_prompt, Instant::now());
            match decision {
                Reveal::Show => show(&app),
                Reveal::Prompt => {
                    let unlocked = match prompt() {
                        Ok(unlocked) => unlocked,
                        Err(e) => {
                            // Fail closed: the window stays hidden. The
                            // next reveal asks again.
                            log::warn!("window lock: couldn't ask to unlock: {e}");
                            false
                        }
                    };
                    let show_now = lock().prompt_finished(unlocked, Instant::now());
                    if show_now {
                        show(&app);
                    } else {
                        log::info!("window lock: unlock cancelled, the window stays hidden");
                    }
                }
                Reveal::Pending | Reveal::Refused => {}
            }
        });
    if let Err(e) = spawned {
        log::warn!("window lock: couldn't start the reveal: {e}");
    }
}

fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    notify(true);
}

fn notify(open: bool) {
    if let Some(callback) = ON_OPEN_CHANGED.get() {
        callback(open);
    }
}

/// Re-read the lock settings from the backend. Keeps the last values if
/// the read fails.
fn refresh_policy() {
    let Some(state) = crate::STATE.get() else {
        return;
    };
    match crate::settings::fetch(&state.sidecar_base_url) {
        Ok(settings) => {
            lock().set_policy(settings.require_unlock, settings.auto_lock_idle_minutes);
        }
        Err(e) => log::warn!("window lock: couldn't read the lock settings, keeping the last ones: {e}"),
    }
}

#[cfg(target_os = "macos")]
fn prompt() -> Result<bool, String> {
    crate::touch_id::prompt(PROMPT_REASON, PROMPT_TIMEOUT)
}

/// The setting is macOS-only (see DesktopAppSection); elsewhere there is
/// nothing to ask, as in `authenticate_touch_id`.
#[cfg(not(target_os = "macos"))]
fn prompt() -> Result<bool, String> {
    Ok(true)
}

/// Time since the last keyboard or mouse input anywhere in this login
/// session. Needs no permission.
#[cfg(target_os = "macos")]
fn system_idle() -> Option<Duration> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    }
    // kCGEventSourceStateCombinedSessionState and kCGAnyInputEventType.
    const COMBINED_SESSION_STATE: i32 = 0;
    const ANY_INPUT_EVENT: u32 = u32::MAX;
    // SAFETY: a plain C function over two integers, with no pointers.
    let seconds =
        unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) };
    Duration::try_from_secs_f64(seconds).ok()
}

#[cfg(not(target_os = "macos"))]
fn system_idle() -> Option<Duration> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn at(start: Instant, secs: u64) -> Instant {
        start + Duration::from_secs(secs)
    }

    #[test]
    fn without_the_setting_every_reveal_shows_the_window() {
        let t0 = Instant::now();
        let mut lock = Lock::new();
        assert_eq!(lock.request_reveal(true, t0), Reveal::Show);
        assert!(lock.is_open());
        lock.closed();
        // Even a caller that must not prompt gets the window.
        assert_eq!(lock.request_reveal(false, t0), Reveal::Show);
    }

    #[test]
    fn a_locked_window_asks_before_it_shows() {
        let t0 = Instant::now();
        let mut lock = Lock::new();
        lock.set_policy(true, 15);

        assert_eq!(lock.request_reveal(true, t0), Reveal::Prompt);
        assert!(!lock.is_open(), "nothing shows while the prompt is up");
        // A second request while the prompt is up waits on the first.
        assert_eq!(lock.request_reveal(true, t0), Reveal::Pending);

        assert!(lock.prompt_finished(true, t0));
        assert!(lock.is_open());
        // Once unlocked, the next reveal needs no prompt.
        assert_eq!(lock.request_reveal(true, t0), Reveal::Show);
    }

    #[test]
    fn a_cancelled_or_failed_prompt_keeps_the_window_locked() {
        let t0 = Instant::now();
        let mut lock = Lock::new();
        lock.set_policy(true, 15);

        assert_eq!(lock.request_reveal(true, t0), Reveal::Prompt);
        assert!(!lock.prompt_finished(false, t0));
        assert!(!lock.is_open());
        // The next request asks again rather than waiting on a finished prompt.
        assert_eq!(lock.request_reveal(true, t0), Reveal::Prompt);
    }

    #[test]
    fn hiding_the_window_locks_it_again() {
        let t0 = Instant::now();
        let mut lock = Lock::new();
        lock.set_policy(true, 15);
        assert_eq!(lock.request_reveal(true, t0), Reveal::Prompt);
        assert!(lock.prompt_finished(true, t0));

        lock.closed();
        assert!(!lock.is_open());
        assert_eq!(lock.request_reveal(true, t0), Reveal::Prompt);
    }

    #[test]
    fn a_caller_that_must_not_prompt_is_refused_while_locked() {
        let t0 = Instant::now();
        let mut lock = Lock::new();
        lock.set_policy(true, 15);
        assert_eq!(lock.request_reveal(false, t0), Reveal::Refused);
        assert!(!lock.is_open());
        // Refusing starts no prompt, so a later request can still ask.
        assert_eq!(lock.request_reveal(true, t0), Reveal::Prompt);
    }

    #[test]
    fn turning_the_setting_on_applies_from_the_next_hide() {
        let t0 = Instant::now();
        let mut lock = Lock::new();
        assert_eq!(lock.request_reveal(true, t0), Reveal::Show);

        // Settings turns it on (after its own Touch ID check) while the
        // window is open: the window stays open until it is hidden.
        lock.set_policy(true, 15);
        assert_eq!(lock.request_reveal(true, t0), Reveal::Show);
        lock.closed();
        assert_eq!(lock.request_reveal(true, t0), Reveal::Prompt);
    }

    #[test]
    fn auto_lock_fires_after_the_idle_time_and_only_when_armed() {
        let t0 = Instant::now();
        let mut lock = Lock::new();
        lock.set_policy(true, 5);
        assert_eq!(lock.request_reveal(true, t0), Reveal::Prompt);
        assert!(lock.prompt_finished(true, t0));

        assert!(!lock.auto_lock_due(at(t0, 299)));
        assert!(lock.auto_lock_due(at(t0, 300)));

        // 0 minutes turns auto-lock off.
        lock.set_policy(true, 0);
        assert!(!lock.auto_lock_due(at(t0, 3600)));
        // So does turning the unlock requirement off.
        lock.set_policy(false, 5);
        assert!(!lock.auto_lock_due(at(t0, 3600)));
        // And a hidden window has nothing to lock.
        lock.set_policy(true, 5);
        lock.closed();
        assert!(!lock.auto_lock_due(at(t0, 3600)));
    }

    #[test]
    fn input_while_focused_keeps_the_window_open() {
        let t0 = Instant::now();
        let mut lock = Lock::new();
        lock.set_policy(true, 5);
        assert_eq!(lock.request_reveal(true, t0), Reveal::Prompt);
        assert!(lock.prompt_finished(true, t0));

        // Focused, last input 10 s before this tick at 4 min.
        lock.observe(at(t0, 240), true, Some(Duration::from_secs(10)));
        assert!(!lock.auto_lock_due(at(t0, 300)));
        assert!(lock.auto_lock_due(at(t0, 230 + 300)));

        // Focused but idle: the last input is what counts.
        lock.observe(at(t0, 600), true, Some(Duration::from_secs(400)));
        assert!(lock.auto_lock_due(at(t0, 600)));
    }

    #[test]
    fn input_elsewhere_does_not_keep_a_background_window_open() {
        let t0 = Instant::now();
        let mut lock = Lock::new();
        lock.set_policy(true, 5);
        assert_eq!(lock.request_reveal(true, t0), Reveal::Prompt);
        assert!(lock.prompt_finished(true, t0));

        // The window loses focus at 60 s; the user keeps typing elsewhere.
        lock.note_activity(at(t0, 60));
        lock.observe(at(t0, 200), false, Some(Duration::ZERO));
        lock.observe(at(t0, 359), false, Some(Duration::ZERO));
        assert!(!lock.auto_lock_due(at(t0, 359)));
        assert!(lock.auto_lock_due(at(t0, 360)));
    }

    #[test]
    fn without_an_idle_reading_focus_counts_as_use() {
        let t0 = Instant::now();
        let mut lock = Lock::new();
        lock.set_policy(true, 5);
        assert_eq!(lock.request_reveal(true, t0), Reveal::Prompt);
        assert!(lock.prompt_finished(true, t0));

        lock.observe(at(t0, 290), true, None);
        assert!(!lock.auto_lock_due(at(t0, 500)));
        assert!(lock.auto_lock_due(at(t0, 590)));
    }

    /// A window shown anywhere but here skips the prompt, so the gate's own
    /// calls must be the only ones in the shell. `.show()` on a native
    /// notification is the one other use of the name.
    #[test]
    fn every_reveal_goes_through_the_gate() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut gate_calls = 0;
        let mut offenders = Vec::new();
        // Assembled at runtime so this test doesn't match itself.
        let show = format!(".{}()", "show");
        let hide = format!(".{}()", "hide");
        for (path, text) in rust_sources(&src) {
            let code = strip_line_comments(&text);
            if path.ends_with("window_lock.rs") {
                gate_calls = code.matches(show.as_str()).count();
                continue;
            }
            for (at, _) in code.match_indices(show.as_str()) {
                if !statement_before(&code, at).contains(".notification()") {
                    offenders.push(format!("{} calls {show}", path.display()));
                }
            }
            if code.contains(hide.as_str()) {
                offenders.push(format!("{} calls {hide}", path.display()));
            }
        }
        // Proves the scan read the shell's sources rather than nothing.
        assert_eq!(gate_calls, 1, "expected the gate's own show() in window_lock.rs");
        assert!(
            offenders.is_empty(),
            "show and hide the main window through window_lock so the unlock setting holds: {offenders:?}",
        );
    }

    fn strip_line_comments(text: &str) -> String {
        text.lines()
            .map(|line| match line.find("//") {
                Some(i) => &line[..i],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The text from the end of the previous statement or block up to `at`.
    fn statement_before(code: &str, at: usize) -> &str {
        let start = code[..at]
            .rfind(|c| matches!(c, ';' | '{' | '}'))
            .map_or(0, |i| i + 1);
        &code[start..at]
    }

    fn rust_sources(dir: &Path) -> Vec<(PathBuf, String)> {
        let mut sources = Vec::new();
        for entry in fs::read_dir(dir).expect("read source dir") {
            let path = entry.expect("source dir entry").path();
            if path.is_dir() {
                sources.extend(rust_sources(&path));
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let text = fs::read_to_string(&path).expect("read source file");
                sources.push((path, text));
            }
        }
        sources
    }
}
