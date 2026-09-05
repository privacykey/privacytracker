// Apple Configurator `cfgutil` bridge.
//
// Exposes two Tauri commands to the webview:
//
//   - `check_cfgutil` — probes whether `cfgutil` is on PATH (or at a handful
//     of well-known locations Apple Configurator 2 installs it to). Pure
//     detection; nothing is mutated.
//
//   - `run_cfgutil_export` — invokes `cfgutil --format JSON get installedApps`
//     against the selected device when the UI provides an ECID, parses the
//     JSON permissively, and returns {name, developer, bundleId, version}
//     rows. The UI hands those rows straight into the existing Step-2 name
//     list so the rest of the onboarding flow is the CSV-import path users
//     already trust.
//
// Why JSON rather than CSV? cfgutil's default tabular output changes shape
// between versions and doesn't include column headers. Its `--format JSON`
// mode is far more stable to parse, and we'd rather do the conversion here
// than ship a CSV dialect into the existing Node-side parser.
//
// Non-macOS hosts: the commands still compile, but `check_cfgutil` returns
// `available: false` with a reason string and `run_cfgutil_export` returns a
// structured error. Apple Configurator only ships on macOS, so there's no
// sensible Linux/Windows path to wire up.

#[cfg(target_os = "macos")]
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "macos")]
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
#[cfg(target_os = "macos")]
use serde_json::Value;

/// Cached result of `detect_cfgutil_impl`. The PATH probe + Automation Tools
/// check + version probe shells out 2–4 times and can take 5–30s on a cold
/// call. Internal callers (`list_connected_devices`, `run_cfgutil_export`)
/// fire many times per session and don't need a fresh probe each time —
/// nothing about the cfgutil install changes between calls.
///
/// The cache TTL is generous (5 min); the user-facing "Re-check" button in
/// the onboarding wizard always calls `detect_cfgutil_impl` directly via
/// `check_cfgutil`, so a fresh install or PATH edit is reflected the next
/// time the user clicks Re-check.
#[cfg(target_os = "macos")]
const CFGUTIL_DETECT_TTL: Duration = Duration::from_secs(300);
#[cfg(target_os = "macos")]
static CFGUTIL_DETECT_CACHE: Mutex<Option<(Instant, CfgutilCheck)>> = Mutex::new(None);

/// Return the cached `CfgutilCheck` if it's fresh, otherwise re-probe and
/// store the result. Internal helper for the cfgutil shell paths so they
/// don't pay the 5-30s detection cost on every poll.
#[cfg(target_os = "macos")]
fn cached_detect_cfgutil() -> CfgutilCheck {
    if let Some((at, value)) = CFGUTIL_DETECT_CACHE.lock().ok().and_then(|g| g.clone()) {
        if at.elapsed() < CFGUTIL_DETECT_TTL {
            return value;
        }
    }
    let fresh = detect_cfgutil_impl();
    if let Ok(mut guard) = CFGUTIL_DETECT_CACHE.lock() {
        *guard = Some((Instant::now(), fresh.clone()));
    }
    fresh
}

/// Fixed locations `cfgutil` is known to show up at on a stock macOS install.
///
/// When "Install Automation Tools" has been chosen from the Configurator
/// menu, a symlink lands at `/usr/local/bin/cfgutil`. If that hasn't been
/// run yet, the binary still exists inside the .app bundle but isn't on
/// PATH — we fall back to that so we can detect "Configurator installed,
/// automation tools not yet installed" and tell the user what to do.
#[cfg(target_os = "macos")]
const FALLBACK_CFGUTIL_PATHS: &[&str] = &[
    "/usr/local/bin/cfgutil",
    "/opt/homebrew/bin/cfgutil",
    "/Applications/Apple Configurator 2.app/Contents/MacOS/cfgutil",
    "/Applications/Apple Configurator.app/Contents/MacOS/cfgutil",
];

/// Result shape returned by `check_cfgutil`. All fields are optional so the
/// UI can render helpful messages no matter which rung of the detection
/// ladder succeeded (or failed).
#[derive(Debug, Serialize, Default, Clone)]
pub struct CfgutilCheck {
    /// True iff we managed to run a harmless `cfgutil list` capability probe.
    /// Some cfgutil builds do not support `--version`, so availability must
    /// not depend on version output.
    pub available: bool,

    /// Best-effort version if this cfgutil build exposes one. `None` is
    /// normal on builds that only expose operational commands.
    pub version: Option<String>,

    /// Absolute path to the cfgutil binary we actually invoked. `None`
    /// on non-macOS hosts.
    pub path: Option<String>,

    /// Output of `cfgutil get supportedPropertyNames`, when the build
    /// exposes it. Diagnostics-only: the guardian age-rating feature wants
    /// to know if Apple ever surfaces a child age-range / restrictions
    /// property over USB (iOS 26's DeclaredAgeRange is in-app only today).
    /// The webview highlights any age/child/restriction-flavoured names.
    pub supported_property_names: Option<Vec<String>>,

    /// True when `/usr/local/bin/cfgutil` exists — the symlink Apple
    /// Configurator drops when "Install Automation Tools" has been run.
    /// When Configurator is installed but this is false, we surface the
    /// "open the Configurator menu → Install Automation Tools" prompt.
    pub automation_tools_installed: bool,

    /// True when /Applications/Apple Configurator 2.app exists on the
    /// filesystem, regardless of whether cfgutil itself is reachable.
    /// Drives the "App installed — now install the automation tools" copy.
    pub app_installed: bool,

    /// Best-effort reason when `available` is false. Shown verbatim to the
    /// user when we couldn't find cfgutil or it failed to execute.
    pub error: Option<String>,

    /// macOS / windows / linux. Lets the UI decide whether to even offer
    /// the auto-import path — we only show it on macOS.
    pub platform: &'static str,
}

/// Single row returned by `run_cfgutil_export`. Matches the shape of
/// `parseImportedAppRows`'s "rows" on the Node side closely enough that
/// the UI can feed it directly into the existing import pipeline.
///
/// Serializes with snake_case field names (the serde default) — the JS
/// wrapper in `lib/desktop.ts` reads `app.bundle_id` and translates to
/// camelCase before handing the result up to the wizard. That keeps
/// the snake/camel translation in one place (the wrapper) instead of
/// scattered between here and the outer `CfgutilExport` struct.
#[derive(Debug, Serialize, Default, Clone)]
pub struct CfgutilApp {
    /// Display name as reported by Apple — prefer `bundleName`, fall back
    /// to `name`, fall back to `title`. Empty names are dropped upstream.
    pub name: String,

    /// Seller / vendor string. Not always populated; nullable. Used by
    /// developer-hint ranking on Step 2 of the wizard.
    pub developer: Option<String>,

    /// Apple bundle id (com.example.foo). Two uses on the JS side:
    ///   1. Cross-device dedupe inside this Rust function (apps installed
    ///      on multiple connected devices collapse to one row).
    ///   2. *Direct* iTunes lookup on Step 2 of the wizard — bundle IDs
    ///      are unique per App Store record, so a `lookup?bundleId=…`
    ///      call returns the canonical match without the name-collision
    ///      / developer-hint guesswork that name search needs. The
    ///      wizard pre-populates Step 3 selections from the lookup
    ///      results and only falls back to name search for the rare
    ///      misses (unlisted/sideloaded/enterprise apps).
    pub bundle_id: Option<String>,

    /// Short version reported by the device. Surfaced back to the UI only
    /// for display, not used in matching.
    pub version: Option<String>,
}

/// Result shape returned by `run_cfgutil_export`.
#[derive(Debug, Serialize, Default)]
pub struct CfgutilExport {
    /// Number of devices cfgutil found connected. Zero means "plug one in".
    pub device_count: usize,

    /// Flattened, deduped app list across every connected device.
    pub apps: Vec<CfgutilApp>,

    /// Raw stdout from cfgutil, kept around for diagnostics if the parse
    /// comes back empty. The UI truncates this before displaying — it can
    /// run to hundreds of kilobytes on a phone with many apps.
    pub raw_stdout: String,
}

/// Single connected device, surfaced by `list_connected_devices`. The
/// webview polls this endpoint to render a "iPhone (Aria's iPhone)
/// connected — import?" toast whenever a new device shows up. Kept to a
/// small, descriptive set of fields so the toast can render without
/// extra round-trips.
#[derive(Debug, Serialize, Default, Clone)]
pub struct ConnectedDevice {
    /// ECID — Apple's stable per-device identifier. Used as the React key
    /// on the webview side and as the dedupe key when comparing two
    /// successive polls. Never persisted; not surfaced to the user.
    pub ecid: String,

    /// Display name. Prefers `cfgutil get name`'s output ("Aria's iPhone")
    /// but falls back to the model when the name lookup fails.
    pub name: Option<String>,

    /// Apple model string ("iPhone15,3" / "iPad13,1"). Coerced into a
    /// human label upstream — Rust just passes through what cfgutil
    /// reports.
    pub model: Option<String>,

    /// iOS / iPadOS version string ("17.4.1"). Used purely for display.
    pub ios_version: Option<String>,

    /// Device class — "iPhone", "iPad", etc. Drives the icon glyph on
    /// the toast.
    pub device_class: Option<String>,
}

/// Result of `list_connected_devices`. Lightweight on purpose — the
/// webview polls this endpoint, so the response shape needs to stay
/// cheap to compute. No installed-apps payload here; that comes via
/// `run_cfgutil_export` only after the user clicks "Import".
#[derive(Debug, Serialize, Default)]
pub struct ConnectedDeviceList {
    /// Every device cfgutil sees right now. Empty array on a host where
    /// nothing's plugged in (the common idle state).
    pub devices: Vec<ConnectedDevice>,

    /// True when cfgutil itself isn't available on this host. The webview
    /// uses this to suppress the "checking for devices…" UX entirely on
    /// non-macOS / non-Configurator installs rather than polling forever.
    pub cfgutil_unavailable: bool,
}

/// Public check command. Thin wrapper so we can keep the platform-specific
/// work inside `detect_cfgutil_impl` and mock it without a `#[cfg]` inside
/// the Tauri command body.
#[tauri::command]
pub async fn check_cfgutil() -> CfgutilCheck {
    // cfgutil shell-outs can take 5–30s on cold call (PATH probe +
    // Automation Tools check + version probe). Running them on the
    // Tauri runtime thread blocks IPC dispatch — including the
    // eval_script calls that deliver responses back to the webview,
    // freezing the UI. spawn_blocking moves the work to a worker
    // thread so the runtime stays responsive.
    //
    // The user-facing Re-check button calls this directly, so we always
    // invalidate the internal cache first — a fresh install or PATH
    // edit should be reflected immediately, not on the next 5-minute
    // expiry.
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            if let Ok(mut guard) = CFGUTIL_DETECT_CACHE.lock() {
                *guard = None;
            }
        }
        let fresh = detect_cfgutil_impl();
        #[cfg(target_os = "macos")]
        {
            if let Ok(mut guard) = CFGUTIL_DETECT_CACHE.lock() {
                *guard = Some((Instant::now(), fresh.clone()));
            }
        }
        fresh
    })
    .await
    .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn detect_cfgutil_impl() -> CfgutilCheck {
    let mut out = CfgutilCheck {
        platform: "macos",
        ..Default::default()
    };

    // Presence of the .app bundle tells the UI whether to prompt for a
    // download (link to the App Store) or just for "Install Automation
    // Tools" inside a Configurator they already have.
    out.app_installed = std::path::Path::new("/Applications/Apple Configurator 2.app").exists()
        || std::path::Path::new("/Applications/Apple Configurator.app").exists();
    out.automation_tools_installed = std::path::Path::new("/usr/local/bin/cfgutil").exists();

    // Try PATH first so we pick up the user's preferred installation (they
    // may have multiple). If that fails, walk the known-install paths in
    // order. Availability is proven with `cfgutil --format JSON list`: it is
    // harmless, works with no connected devices, and is supported by builds
    // that reject `--version` with "Unknown option '--version'".
    let path_candidate = which_cfgutil().unwrap_or_default();
    let probe_paths: Vec<String> = if path_candidate.is_empty() {
        FALLBACK_CFGUTIL_PATHS
            .iter()
            .map(|p| (*p).to_string())
            .collect()
    } else {
        let mut v = vec![path_candidate];
        for fallback in FALLBACK_CFGUTIL_PATHS {
            if !v.iter().any(|p| p == fallback) {
                v.push((*fallback).to_string());
            }
        }
        v
    };

    for candidate in probe_paths {
        if !std::path::Path::new(&candidate).exists() {
            continue;
        }
        match run_with_timeout(
            Command::new(&candidate).args(["--format", "JSON", "list"]),
            Duration::from_secs(6),
        ) {
            Ok(list_output) if list_output.status.success() => {
                out.available = true;
                out.version = detect_cfgutil_version(&candidate);
                out.supported_property_names = fetch_supported_property_names(&candidate);
                out.path = Some(candidate);
                return out;
            }
            Ok(list_output) => {
                let stdout = String::from_utf8_lossy(&list_output.stdout)
                    .trim()
                    .to_string();
                let stderr = String::from_utf8_lossy(&list_output.stderr)
                    .trim()
                    .to_string();
                let detail = if stderr.is_empty() { stdout } else { stderr };
                let detail_lower = detail.to_lowercase();
                if detail_lower.contains("no devices")
                    || detail_lower.contains("no connected devices")
                {
                    out.available = true;
                    out.version = detect_cfgutil_version(&candidate);
                    out.supported_property_names = fetch_supported_property_names(&candidate);
                    out.path = Some(candidate);
                    return out;
                }
                out.error = Some(format!(
                    "cfgutil at {} did not pass the device-list check ({}): {}",
                    candidate, list_output.status, detail
                ));
                continue;
            }
            Err(err) => {
                out.error = Some(format!("cfgutil at {} failed: {}", candidate, err));
                // keep looking — the next candidate might succeed
                continue;
            }
        }
    }

    if out.error.is_none() {
        if out.app_installed {
            out.error = Some(
                "Apple Configurator is installed, but cfgutil isn't on PATH. \
                 Open Apple Configurator → menu bar → Install Automation Tools."
                    .to_string(),
            );
        } else {
            out.error = Some(
                "Apple Configurator doesn't appear to be installed. \
                 Install it from the App Store (product ID 1037126344), then re-run this check."
                    .to_string(),
            );
        }
    }

    out
}

/// Probe `cfgutil get supportedPropertyNames` — the documented discovery
/// path for what a given cfgutil build can read off a device. Output is a
/// loose text list; tokenise on whitespace/commas and keep identifier-ish
/// tokens. Best-effort: any failure (old build, no devices required-error)
/// returns None and the check result simply omits the field.
#[cfg(target_os = "macos")]
fn fetch_supported_property_names(candidate: &str) -> Option<Vec<String>> {
    let output = run_with_timeout(
        Command::new(candidate).args(["get", "supportedPropertyNames"]),
        Duration::from_secs(6),
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let names: Vec<String> = stdout
        .split(|c: char| c.is_whitespace() || c == ',')
        .map(str::trim)
        .filter(|tok| !tok.is_empty() && tok.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .map(str::to_string)
        .collect();
    if names.is_empty() {
        None
    } else {
        Some(names)
    }
}

#[cfg(target_os = "macos")]
fn detect_cfgutil_version(candidate: &str) -> Option<String> {
    let probes: &[&[&str]] = &[&["version"], &["--version"], &["-v"]];
    for args in probes {
        let Ok(output) =
            run_with_timeout(Command::new(candidate).args(*args), Duration::from_secs(3))
        else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let version = if !stdout.is_empty() { stdout } else { stderr };
        if !version.is_empty() {
            return Some(version);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn detect_cfgutil_impl() -> CfgutilCheck {
    CfgutilCheck {
        available: false,
        platform: if cfg!(windows) { "windows" } else { "linux" },
        error: Some(
            "Apple Configurator and cfgutil are macOS-only. \
             Use an Apple Configurator CSV exported on a Mac, or switch to one \
             of the other import methods."
                .to_string(),
        ),
        ..Default::default()
    }
}

#[cfg(target_os = "macos")]
fn which_cfgutil() -> Option<String> {
    // Lean on the user's own PATH resolution rather than shelling out to
    // `which` — less surprising when the user has a custom PATH (homebrew
    // under /opt, nix, etc.). Falls back to an empty string on failure,
    // which the caller treats as "nothing on PATH".
    let output = Command::new("/usr/bin/env")
        .args(["bash", "-lc", "command -v cfgutil || true"])
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Public export command. Runs cfgutil twice — first to list devices, then
/// to read installed apps from the selected ECID — and returns a rich
/// error string rather than a panicking Err so the UI can offer a retry
/// without a full wizard reset.
///
/// `ecid` is optional at the command boundary for backwards compatibility.
/// The onboarding UI now selects a specific device first and passes it
/// through so a user with two phones plugged in imports from the one they
/// actually chose.
#[tauri::command]
pub async fn run_cfgutil_export(ecid: Option<String>) -> Result<CfgutilExport, String> {
    tauri::async_runtime::spawn_blocking(move || run_cfgutil_export_impl(ecid))
        .await
        .map_err(|e| format!("cfgutil export task failed to start: {e}"))?
}

#[cfg(target_os = "macos")]
fn run_cfgutil_export_impl(ecid: Option<String>) -> Result<CfgutilExport, String> {
    let check = cached_detect_cfgutil();
    if !check.available {
        return Err(check
            .error
            .unwrap_or_else(|| "cfgutil is not available on this host.".to_string()));
    }
    let cfgutil_path = check.path.clone().unwrap_or_else(|| "cfgutil".to_string());

    // 1. Enumerate connected devices. `cfgutil list` / `cfgutil --format JSON
    //    list` both work here; we prefer JSON for stable parsing. Output
    //    shape (abridged):
    //      { "Output": { "<ECID1>": { "name": "...", ... }, ... } }
    //    When nothing's connected, "Output" is an empty object.
    let list_output = run_with_timeout(
        Command::new(&cfgutil_path).args(["--format", "JSON", "list"]),
        Duration::from_secs(10),
    )
    .map_err(|e| format!("cfgutil list failed: {e}"))?;

    if !list_output.status.success() {
        let stderr = String::from_utf8_lossy(&list_output.stderr);
        return Err(format!(
            "cfgutil list exited non-zero ({}): {}",
            list_output.status, stderr
        ));
    }

    let list_stdout = String::from_utf8_lossy(&list_output.stdout).to_string();
    let devices = parse_ecids(&list_stdout);

    if devices.is_empty() {
        return Err(
            "No devices are connected. Plug an iPhone or iPad into this Mac with a USB cable, \
             trust the computer on the device's lock screen, then try again."
                .to_string(),
        );
    }

    // 2. Read installed apps. Without an explicit ECID, `cfgutil` fans the
    //    `get installedApps` call across every connected device — the
    //    historical default for the wizard's "Run export" button. With
    //    one provided, we scope to just that device so a multi-device
    //    setup doesn't import apps from the wrong phone. The argv is
    //    built up in a Vec so the conditional `--ecid <id>` prefix
    //    sits cleanly without a duplicated invocation.
    let mut apps_args: Vec<String> = vec!["--format".to_string(), "JSON".to_string()];
    if let Some(ref e) = ecid {
        // Defence in depth — refuse anything that doesn't look like a
        // hex-style ECID. cfgutil treats `--ecid foo` permissively; we
        // don't.
        if e.chars().any(|c| !c.is_ascii_alphanumeric()) {
            return Err(format!(
                "Refusing to scope export — ECID has unexpected characters: {e}"
            ));
        }
        apps_args.push("--ecid".to_string());
        apps_args.push(e.clone());
    }
    apps_args.push("get".to_string());
    apps_args.push("installedApps".to_string());

    let apps_output = run_with_timeout(
        Command::new(&cfgutil_path).args(&apps_args),
        // Real phones with ~400 apps have measured around 8-12s here; give
        // it a comfortable budget before declaring it hung.
        Duration::from_secs(90),
    )
    .map_err(|e| format!("cfgutil get installedApps failed: {e}"))?;

    let apps_stdout = String::from_utf8_lossy(&apps_output.stdout).to_string();
    let apps_stderr = String::from_utf8_lossy(&apps_output.stderr).to_string();

    if !apps_output.status.success() {
        return Err(format!(
            "cfgutil get installedApps exited non-zero ({}): {}",
            apps_output.status,
            if apps_stderr.is_empty() {
                &apps_stdout
            } else {
                &apps_stderr
            }
        ));
    }

    let apps = parse_installed_apps(&apps_stdout);

    // device_count reflects what the export actually covered — when an
    // ECID was specified we narrowed to one device, so the wizard
    // should say "1 device" in its summary copy regardless of how
    // many phones were actually attached.
    let covered_count = if ecid.is_some() { 1 } else { devices.len() };

    Ok(CfgutilExport {
        device_count: covered_count,
        apps,
        raw_stdout: apps_stdout,
    })
}

#[cfg(not(target_os = "macos"))]
fn run_cfgutil_export_impl(_ecid: Option<String>) -> Result<CfgutilExport, String> {
    Err(
        "Apple Configurator and cfgutil are macOS-only. Use an Apple Configurator CSV exported \
         on a Mac, or switch to one of the other import methods."
            .to_string(),
    )
}

/// Lightweight "what devices are plugged in right now?" probe used by the
/// webview's connect-toast poller. Distinct from `run_cfgutil_export` in
/// two important ways:
///
///   1. It only reads device metadata — name, model, OS version. No
///      installed-apps fan-out. That keeps the call cheap (sub-second
///      on a healthy device) so polling every few seconds is sustainable.
///
///   2. It returns `cfgutil_unavailable: true` instead of a hard error
///      when the binary isn't reachable. The webview wants to suppress
///      polling silently on hosts without Configurator — propagating
///      "cfgutil missing" to the user every 5 seconds would be noise.
///
/// Polling cadence + lifecycle is owned by the webview side (see
/// `lib/desktop.ts` + the device-connect toast component). The Rust
/// side stays request/response so the webview can stop polling whenever
/// it likes (page unmount, user dismisses) without having to tear down
/// any background task.
#[tauri::command]
pub async fn list_connected_devices() -> ConnectedDeviceList {
    // The hottest cfgutil entry by far — DeviceConnectedToast polls this
    // every few seconds while the user is on /dashboard/apps. Two
    // sequential cfgutil shell-outs (`list` + `get name model ...`)
    // dominate. Off-loading them keeps the IPC thread free to deliver
    // responses to whatever else the webview is doing.
    tauri::async_runtime::spawn_blocking(list_connected_devices_impl)
        .await
        .unwrap_or_else(|_| ConnectedDeviceList {
            devices: Vec::new(),
            cfgutil_unavailable: true,
        })
}

/// Synchronous wrapper for the IOKit USB watcher. The watcher already
/// runs on a dedicated background thread (see `usb_watcher.rs`), so we
/// don't need to off-load to spawn_blocking — calling the impl directly
/// is fine. Kept as a separate function so the only public entry points
/// outside cfgutil.rs are this + the async `#[tauri::command]` wrappers.
#[cfg(target_os = "macos")]
pub fn list_connected_devices_for_watcher() -> ConnectedDeviceList {
    list_connected_devices_impl()
}

#[cfg(not(target_os = "macos"))]
pub fn list_connected_devices_for_watcher() -> ConnectedDeviceList {
    ConnectedDeviceList {
        devices: Vec::new(),
        cfgutil_unavailable: true,
    }
}

#[cfg(target_os = "macos")]
fn list_connected_devices_impl() -> ConnectedDeviceList {
    let check = cached_detect_cfgutil();
    if !check.available {
        return ConnectedDeviceList {
            devices: Vec::new(),
            cfgutil_unavailable: true,
        };
    }
    let cfgutil_path = check.path.unwrap_or_else(|| "cfgutil".to_string());

    // Step 1: enumerate ECIDs. Mirrors the prelude of run_cfgutil_export
    // — same JSON shape, same parser. Anything that fails here collapses
    // to "no devices" rather than an error string; the toast component
    // treats an empty list as the idle state.
    let list_output = match run_with_timeout(
        Command::new(&cfgutil_path).args(["--format", "JSON", "list"]),
        Duration::from_secs(6),
    ) {
        Ok(out) if out.status.success() => out,
        _ => {
            return ConnectedDeviceList {
                devices: Vec::new(),
                cfgutil_unavailable: false,
            };
        }
    };
    let list_stdout = String::from_utf8_lossy(&list_output.stdout).to_string();
    let ecids = parse_ecids(&list_stdout);
    if ecids.is_empty() {
        return ConnectedDeviceList {
            devices: Vec::new(),
            cfgutil_unavailable: false,
        };
    }

    // Step 2: fetch the descriptive fields. cfgutil's `get` command
    // accepts multiple keys in one shot and returns them grouped by
    // ECID, so we can pull every device's name + model + OSVersion in a
    // single subprocess. The `deviceClass` key isn't always available on
    // older cfgutil builds — `first_non_empty_string` in the parser
    // handles the absence gracefully.
    let info_output = match run_with_timeout(
        Command::new(&cfgutil_path).args([
            "--format",
            "JSON",
            "get",
            "name",
            "model",
            "OSVersion",
            "deviceClass",
        ]),
        Duration::from_secs(8),
    ) {
        Ok(out) if out.status.success() => out,
        _ => {
            // Worst case — return minimal device entries with just the
            // ECID populated so the UI can at least say "an iOS device
            // is connected" instead of going silent.
            let devices = ecids
                .into_iter()
                .map(|ecid| ConnectedDevice {
                    ecid,
                    ..Default::default()
                })
                .collect();
            return ConnectedDeviceList {
                devices,
                cfgutil_unavailable: false,
            };
        }
    };

    let info_stdout = String::from_utf8_lossy(&info_output.stdout).to_string();
    let devices = parse_device_info(&info_stdout, &ecids);

    ConnectedDeviceList {
        devices,
        cfgutil_unavailable: false,
    }
}

#[cfg(not(target_os = "macos"))]
fn list_connected_devices_impl() -> ConnectedDeviceList {
    ConnectedDeviceList {
        devices: Vec::new(),
        cfgutil_unavailable: true,
    }
}

/// Result of `run_cfgutil_backup`. Reports success/failure separately
/// from the path so the webview can surface a tidy "backup saved to X
/// at HH:MM" toast without parsing free-form stderr.
#[derive(Debug, Serialize, Default)]
pub struct CfgutilBackupResult {
    /// True iff cfgutil exited 0 AND privacytracker found a new or updated,
    /// non-empty Manifest.db under Apple's MobileSync backup root. An exit
    /// code by itself is never enough to unlock the uninstall flow.
    pub ok: bool,

    /// ECID the backup ran against. Echoed back so the caller can
    /// match the response to the request without holding state.
    pub ecid: String,

    /// Canonical filesystem path to the verified UDID backup directory.
    /// NULL on every failure; there is deliberately no requested-path
    /// fallback because cfgutil chooses the MobileSync destination.
    pub backup_path: Option<String>,

    /// Epoch ms when cfgutil reported success. NULL on failure.
    pub finished_at: Option<u64>,

    /// stderr contents on failure, or anything cfgutil printed to the
    /// progress channel on success. Truncated upstream before being
    /// surfaced to the user.
    pub log: String,

    /// Filled with a human-readable error message on failure.
    pub error: Option<String>,
}

/// Minimal on-disk signature for a backup directory. Incremental iOS
/// backups reuse the same UDID directory, so discovery cannot rely only on
/// seeing a new folder: a changed Manifest.db (or directory mtime) is the
/// proof that this invocation wrote or refreshed a backup.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct BackupSignature {
    directory_modified: Option<SystemTime>,
    manifest_bytes: u64,
    manifest_modified: Option<SystemTime>,
}

/// Apple Configurator's documented destination for `cfgutil backup`.
/// cfgutil 2.20 exposes no per-command destination option; it stores one
/// direct child directory per device UDID beneath this root.
#[cfg(target_os = "macos")]
fn mobile_sync_backup_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve user home dir".to_string())?;
    Ok(home
        .join("Library")
        .join("Application Support")
        .join("MobileSync")
        .join("Backup"))
}

/// Return every complete-looking direct child backup beneath `root`.
/// Symlinks are rejected at both the directory and Manifest.db boundary,
/// and canonical paths must remain inside the canonical MobileSync root.
/// A zero-byte Manifest.db is incomplete and therefore not evidence that a
/// restorable backup exists.
#[cfg(target_os = "macos")]
fn scan_verified_backups(root: &Path) -> std::io::Result<HashMap<PathBuf, BackupSignature>> {
    use std::io::ErrorKind;

    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error),
    };
    let canonical_root = root.canonicalize()?;
    let mut backups = HashMap::new();

    for entry in entries.flatten() {
        let entry_path = entry.path();
        let Ok(entry_type) = entry.file_type() else {
            continue;
        };
        if !entry_type.is_dir() || entry_type.is_symlink() {
            continue;
        }
        let Ok(canonical_path) = entry_path.canonicalize() else {
            continue;
        };
        if canonical_path.parent() != Some(canonical_root.as_path()) {
            continue;
        }

        let manifest_path = canonical_path.join("Manifest.db");
        let Ok(manifest_metadata) = std::fs::symlink_metadata(&manifest_path) else {
            continue;
        };
        if !manifest_metadata.file_type().is_file()
            || manifest_metadata.file_type().is_symlink()
            || manifest_metadata.len() == 0
        {
            continue;
        }
        let Ok(canonical_manifest) = manifest_path.canonicalize() else {
            continue;
        };
        if canonical_manifest.parent() != Some(canonical_path.as_path()) {
            continue;
        }

        let directory_modified = std::fs::metadata(&canonical_path)
            .ok()
            .and_then(|metadata| metadata.modified().ok());
        backups.insert(
            canonical_path,
            BackupSignature {
                directory_modified,
                manifest_bytes: manifest_metadata.len(),
                manifest_modified: manifest_metadata.modified().ok(),
            },
        );
    }

    Ok(backups)
}

#[cfg(target_os = "macos")]
fn signature_recency(signature: &BackupSignature) -> SystemTime {
    signature
        .manifest_modified
        .or(signature.directory_modified)
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// Match only the selected device's UDID directory. Other devices may be
/// backing up concurrently, so global "most recent" discovery is unsafe.
#[cfg(target_os = "macos")]
fn find_changed_verified_backup(
    before: &HashMap<PathBuf, BackupSignature>,
    after: &HashMap<PathBuf, BackupSignature>,
    started_at: SystemTime,
    expected_udid: &str,
) -> Option<PathBuf> {
    let earliest_expected_write = started_at
        .checked_sub(Duration::from_secs(5))
        .unwrap_or(started_at);
    let now = SystemTime::now();
    let mut matches = after.iter().filter(|(path, signature)| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(expected_udid))
            && before.get(*path) != Some(*signature)
            && signature_recency(signature) >= earliest_expected_write
            && signature_recency(signature) <= now
    });
    let (path, _) = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(path.clone())
}

/// Extract the selected ECID's UDID from cfgutil's JSON response. Never
/// accept path syntax from a subprocess result as a backup directory name.
#[cfg(target_os = "macos")]
fn parse_backup_udid(stdout: &str, ecid: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(stdout).ok()?;
    let output = value.get("Output")?.as_object()?;
    let normalize = |value: &str| {
        value
            .trim_start_matches("0x")
            .trim_start_matches("0X")
            .to_ascii_uppercase()
    };
    let expected = normalize(ecid);
    let mut devices = output.iter().filter(|(key, _)| normalize(key) == expected);
    let (_, device) = devices.next()?;
    if devices.next().is_some() {
        return None;
    }
    let udid = device.get("UDID")?.as_str()?;
    if !(16..=64).contains(&udid.len()) || !udid.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    {
        return None;
    }
    Some(udid.to_string())
}

/// Result of `run_cfgutil_remove_app`. Bundles command output so the
/// review-and-act wizard can render per-row success/failure without
/// re-running cfgutil to check.
#[derive(Debug, Serialize, Default)]
pub struct CfgutilRemoveResult {
    pub ok: bool,
    pub ecid: String,
    pub bundle_id: String,
    pub log: String,
    pub error: Option<String>,
}

/// Run the supported `cfgutil --ecid <ecid> backup` command. Apple
/// Configurator owns the destination under MobileSync; privacytracker takes
/// before/after snapshots of that root and returns success only after it
/// verifies a new or changed non-empty Manifest.db.
///
/// Designed to be invoked synchronously from the webview's review-
/// and-act wizard. Long backups can take 5+ minutes on devices with a
/// lot of media; the timeout is generous.
///
/// **Safety note**: this command performs no audience or feature-flag
/// check of its own. The webview is responsible for hiding the entry
/// points unless the user is on `audience=self` and has explicitly
/// flipped `flag.devopts.cfgutil_uninstall` on. The Rust command
/// trusts its caller.
#[tauri::command]
pub async fn run_cfgutil_backup(ecid: String) -> CfgutilBackupResult {
    let ecid_for_err = ecid.clone();
    tauri::async_runtime::spawn_blocking(move || run_cfgutil_backup_impl(ecid))
        .await
        .unwrap_or_else(|e| CfgutilBackupResult {
            ok: false,
            ecid: ecid_for_err,
            error: Some(format!("backup task failed to start: {e}")),
            ..Default::default()
        })
}

#[cfg(target_os = "macos")]
fn run_cfgutil_backup_impl(ecid: String) -> CfgutilBackupResult {
    let mut out = CfgutilBackupResult {
        ecid: ecid.clone(),
        ..Default::default()
    };

    // Refuse anything that isn't a plain ECID. Same allowlist as
    // run_cfgutil_remove_app — defence in depth against a compromised
    // webview trying to smuggle cfgutil flags via --ecid's value.
    if !ecid.chars().all(|c| c.is_ascii_alphanumeric()) {
        out.error = Some(format!(
            "Refusing to back up — ECID contains unexpected characters: {ecid}"
        ));
        return out;
    }

    let backup_root = match mobile_sync_backup_root() {
        Ok(path) => path,
        Err(e) => {
            out.error = Some(format!("Could not locate Apple's backup folder: {e}"));
            return out;
        }
    };
    let before = match scan_verified_backups(&backup_root) {
        Ok(backups) => backups,
        Err(error) => {
            out.error = Some(format!(
                "Could not inspect existing device backups before starting: {error}"
            ));
            return out;
        }
    };

    let check = cached_detect_cfgutil();
    if !check.available {
        out.error = Some(
            check
                .error
                .unwrap_or_else(|| "cfgutil not available".to_string()),
        );
        return out;
    }
    let cfgutil_path = check.path.unwrap_or_else(|| "cfgutil".to_string());

    let identity_output = match run_with_timeout(
        Command::new(&cfgutil_path).args(["--ecid", &ecid, "--format", "JSON", "get", "UDID"]),
        Duration::from_secs(8),
    ) {
        Ok(output) if output.status.success() => output,
        _ => {
            out.error =
                Some("Could not verify the selected device identity before backup.".to_string());
            return out;
        }
    };
    let Some(expected_udid) =
        parse_backup_udid(&String::from_utf8_lossy(&identity_output.stdout), &ecid)
    else {
        out.error = Some(
            "Apple Configurator did not return a valid identity for the selected device."
                .to_string(),
        );
        return out;
    };

    // 5-minute ceiling. Real-world iCloud-light backups land in 30-90s;
    // a media-heavy phone can stretch to 4-5 minutes on USB-2 hardware.
    // Anything past 5 minutes is almost certainly a stuck pairing prompt
    // (the device is asking for a passcode the user hasn't typed) — we
    // surface that as a timeout rather than letting the wizard hang.
    let started_at = SystemTime::now();
    let result = run_with_timeout(
        Command::new(&cfgutil_path).args(["--ecid", &ecid, "--format", "JSON", "backup"]),
        Duration::from_secs(300),
    );

    let output = match result {
        Ok(o) => o,
        Err(e) => {
            out.error = Some(format!("cfgutil backup failed: {e}"));
            return out;
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    out.log = if !stdout.is_empty() {
        stdout.clone()
    } else {
        stderr.clone()
    };

    if !output.status.success() {
        out.error = Some(format!(
            "cfgutil backup exited non-zero ({}): {}",
            output.status,
            if stderr.is_empty() { &stdout } else { &stderr }
        ));
        return out;
    }

    let after = match scan_verified_backups(&backup_root) {
        Ok(backups) => backups,
        Err(error) => {
            out.error = Some(format!(
                "Apple Configurator finished, but privacytracker could not inspect the backup files: {error}. Nothing has been removed."
            ));
            return out;
        }
    };
    let Some(backup_path) =
        find_changed_verified_backup(&before, &after, started_at, &expected_udid)
    else {
        out.error = Some(format!(
            "Apple Configurator finished, but privacytracker could not verify a new or updated Manifest.db in {}. Nothing has been removed. Keep the device connected and unlocked, then try again.",
            backup_root.display()
        ));
        return out;
    };

    out.ok = true;
    out.backup_path = Some(backup_path.to_string_lossy().into_owned());
    out.finished_at = Some(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    );
    out
}

#[cfg(not(target_os = "macos"))]
fn run_cfgutil_backup_impl(ecid: String) -> CfgutilBackupResult {
    CfgutilBackupResult {
        ok: false,
        ecid,
        error: Some("Backups via cfgutil are macOS-only.".to_string()),
        ..Default::default()
    }
}

/// Run `cfgutil --device-id <ecid> remove-app <bundle_id>` against a
/// connected device. Removes the app cleanly (matches what the user
/// would get by long-pressing → Remove App on iOS).
///
/// **Safety note**: as with `run_cfgutil_backup`, the destructive gate
/// (audience must be 'self', flag `flag.devopts.cfgutil_uninstall`
/// must be 'on', a fresh backup must exist) is enforced **upstream of
/// this function** — in the webview's review-and-act wizard. This
/// command exists at all only as the leaf primitive for that wizard;
/// it is not surfaced anywhere else in the UI. If a future entry
/// point is added, the same upstream gate must travel with it.
///
/// Per-app explicit confirmation is the wizard's responsibility too:
/// each call here corresponds to one user "type DELETE → confirm"
/// interaction. There is no batch path; callers wanting to remove N
/// apps loop and call N times.
#[tauri::command]
pub async fn run_cfgutil_remove_app(ecid: String, bundle_id: String) -> CfgutilRemoveResult {
    let ecid_for_err = ecid.clone();
    let bundle_id_for_err = bundle_id.clone();
    tauri::async_runtime::spawn_blocking(move || run_cfgutil_remove_app_impl(ecid, bundle_id))
        .await
        .unwrap_or_else(|e| CfgutilRemoveResult {
            ok: false,
            ecid: ecid_for_err,
            bundle_id: bundle_id_for_err,
            error: Some(format!("remove task failed to start: {e}")),
            ..Default::default()
        })
}

#[cfg(target_os = "macos")]
fn run_cfgutil_remove_app_impl(ecid: String, bundle_id: String) -> CfgutilRemoveResult {
    let mut out = CfgutilRemoveResult {
        ecid: ecid.clone(),
        bundle_id: bundle_id.clone(),
        ..Default::default()
    };

    // Reject obviously bad input before going anywhere near cfgutil.
    // Apple bundle ids are reverse-DNS strings; we don't allow shell
    // metacharacters even though we're using the Command API (which
    // doesn't shell-interpret them) — defence in depth.
    if !bundle_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        out.error = Some(format!(
            "Refusing to remove app — bundle id contains unexpected characters: {bundle_id}"
        ));
        return out;
    }
    if !ecid.chars().all(|c| c.is_ascii_alphanumeric()) {
        out.error = Some(format!(
            "Refusing to remove app — ECID contains unexpected characters: {ecid}"
        ));
        return out;
    }

    // Defence-in-depth: require a fresh Touch ID / device-password
    // confirmation before the destructive cfgutil command runs. The
    // wizard's "type DELETE" prompt is a webview-side check, so a
    // compromised webview could call this command directly to skip it.
    // LAContext is the only confirmation step that a JS payload can't
    // bypass: it's a native modal whose result depends on hardware
    // (the user's finger) or the macOS login password.
    match crate::touch_id::prompt(
        &format!("Confirm removing {bundle_id} from this iPhone"),
        std::time::Duration::from_secs(120),
    ) {
        Ok(true) => {}
        Ok(false) => {
            out.error = Some("Authentication cancelled".to_string());
            return out;
        }
        Err(e) => {
            out.error = Some(format!("Authentication required: {e}"));
            return out;
        }
    }

    let check = cached_detect_cfgutil();
    if !check.available {
        out.error = Some(
            check
                .error
                .unwrap_or_else(|| "cfgutil not available".to_string()),
        );
        return out;
    }
    let cfgutil_path = check.path.unwrap_or_else(|| "cfgutil".to_string());

    let result = run_with_timeout(
        Command::new(&cfgutil_path).args([
            "--ecid",
            &ecid,
            "--format",
            "JSON",
            "remove-app",
            &bundle_id,
        ]),
        Duration::from_secs(45),
    );

    let output = match result {
        Ok(o) => o,
        Err(e) => {
            out.error = Some(format!("cfgutil remove-app failed: {e}"));
            return out;
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    out.log = if !stdout.is_empty() {
        stdout.clone()
    } else {
        stderr.clone()
    };

    if !output.status.success() {
        out.error = Some(format!(
            "cfgutil remove-app exited non-zero ({}): {}",
            output.status,
            if stderr.is_empty() { &stdout } else { &stderr }
        ));
        return out;
    }

    out.ok = true;
    out
}

#[cfg(not(target_os = "macos"))]
fn run_cfgutil_remove_app_impl(ecid: String, bundle_id: String) -> CfgutilRemoveResult {
    CfgutilRemoveResult {
        ok: false,
        ecid,
        bundle_id,
        error: Some("Uninstall via cfgutil is macOS-only.".to_string()),
        ..Default::default()
    }
}

/// Walk `cfgutil get name model OSVersion deviceClass --format JSON` and
/// produce a populated `ConnectedDevice` per ECID. Falls back to a
/// bare-ECID entry for any device whose metadata couldn't be parsed —
/// the toast still renders ("an iOS device connected") rather than
/// dropping the row entirely.
#[cfg(target_os = "macos")]
fn parse_device_info(stdout: &str, ecids: &[String]) -> Vec<ConnectedDevice> {
    let value = serde_json::from_str::<Value>(stdout).ok();
    let output = value
        .as_ref()
        .and_then(|v| v.pointer("/Output"))
        .and_then(|v| v.as_object());

    ecids
        .iter()
        .map(|ecid| {
            let entry = output.and_then(|o| o.get(ecid));
            let name = entry.and_then(|e| first_non_empty_string(e, &["name"]));
            let model = entry.and_then(|e| first_non_empty_string(e, &["model"]));
            let ios_version =
                entry.and_then(|e| first_non_empty_string(e, &["OSVersion", "osVersion"]));
            let device_class =
                entry.and_then(|e| first_non_empty_string(e, &["deviceClass", "deviceType"]));
            ConnectedDevice {
                ecid: ecid.clone(),
                name,
                model,
                ios_version,
                device_class,
            }
        })
        .collect()
}

/// Pull ECID strings out of the `cfgutil list --format JSON` response.
/// We only need the count for UX copy; the get command fans across every
/// attached device on its own.
#[cfg(target_os = "macos")]
fn parse_ecids(stdout: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(stdout) else {
        return Vec::new();
    };
    value
        .pointer("/Output")
        .and_then(|v| v.as_object())
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

/// Walk the cfgutil JSON output and flatten installedApps across every
/// device. Deduplicates by bundleId (first occurrence wins) so two phones
/// with Instagram don't surface it twice.
#[cfg(target_os = "macos")]
fn parse_installed_apps(stdout: &str) -> Vec<CfgutilApp> {
    let Ok(value) = serde_json::from_str::<Value>(stdout) else {
        return Vec::new();
    };

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut result: Vec<CfgutilApp> = Vec::new();

    let devices = value
        .pointer("/Output")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    for (_ecid, device_value) in devices {
        let installed = device_value
            .pointer("/installedApps")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for entry in installed {
            let row = extract_app_row(&entry);
            if row.name.trim().is_empty() {
                continue;
            }
            // Dedup key: prefer bundleId, fall back to lowercased name so a
            // second device that reports the same app without a bundleId still
            // gets suppressed.
            let key = row
                .bundle_id
                .clone()
                .unwrap_or_else(|| row.name.to_lowercase());
            if seen.insert(key) {
                result.push(row);
            }
        }
    }

    result
}

/// Permissive app-row extractor. cfgutil's JSON has drifted across versions
/// — some builds called the display name `bundleName`, others `name`,
/// modern Apple Configurator 2 builds use `displayName` (the home-screen
/// label) and `itunesName` (the longer App Store listing title). Check
/// every plausible key in order and take the first non-empty one we find.
///
/// Empirical sample from Apple Configurator 2 / cfgutil on iOS 17:
///   {
///     "itunesName": "Organic Maps: Offline Maps",
///     "displayName": "Organic Maps",
///     "bundleIdentifier": "app.organicmaps",
///     "bundleVersion": "8"
///   }
///
/// `displayName` is preferred because it's what the user sees on the
/// home screen and is the shorter, more recognisable form for the
/// wizard's "we'll match these to App Store listings" step.
/// `itunesName` falls back when displayName is missing (rare). The
/// legacy keys stay in the list so older cfgutil builds — which the
/// repo originally tested against — keep working.
///
/// cfgutil doesn't provide a developer / publisher field in modern
/// output. The App Store search resolves vendor on Step 3, so leaving
/// `developer` as None is fine; we still try the legacy keys in case
/// a future cfgutil release re-adds one.
#[cfg(target_os = "macos")]
fn extract_app_row(entry: &Value) -> CfgutilApp {
    let name = first_non_empty_string(
        entry,
        &[
            "displayName",         // modern cfgutil, home-screen label
            "itunesName",          // modern cfgutil, App Store listing title
            "bundleName",          // legacy
            "name",                // legacy
            "title",               // legacy
            "CFBundleDisplayName", // raw plist key, very old builds
        ],
    )
    .unwrap_or_default();
    let developer = first_non_empty_string(entry, &["vendor", "developer", "seller", "artistName"]);
    let bundle_id = first_non_empty_string(
        entry,
        &["bundleIdentifier", "bundleId", "CFBundleIdentifier"],
    );
    let version = first_non_empty_string(
        entry,
        &[
            "bundleShortVersion",
            "shortVersion",
            "version",
            "bundleVersion",
            "CFBundleShortVersionString",
        ],
    );

    CfgutilApp {
        name,
        developer,
        bundle_id,
        version,
    }
}

#[cfg(target_os = "macos")]
fn first_non_empty_string(entry: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = entry.get(*key).and_then(|v| v.as_str()) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Shim around `Command::output()` that enforces a wall-clock timeout.
/// cfgutil occasionally hangs against a half-connected device (happens on
/// first trust after a phone reboot); without a timeout we'd stall the
/// Tauri worker indefinitely.
#[cfg(target_os = "macos")]
fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> std::io::Result<std::process::Output> {
    use std::sync::mpsc;
    use std::thread;

    // Re-root the binary path through `PathBuf` so error messages are
    // easier to follow when the caller passed a relative name.
    let program = PathBuf::from(cmd.get_program());
    let (tx, rx) = mpsc::channel();

    // Note: `Command` isn't Send, so we have to own it on the spawned
    // thread. Easiest is to re-build it here with the same args. We only
    // do this path for cfgutil; the extra work is trivial compared to the
    // subprocess cost.
    let args: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect();

    // Hand the spawned thread its own owned copy of the program path so
    // the outer scope still has `program` available to format the
    // timeout error message below. Cloning a `PathBuf` is cheap and the
    // alternative — wrapping in `Arc<Path>` or borrowing through a
    // scoped thread — would be more ceremony than this short-lived
    // helper warrants.
    let program_for_thread = program.clone();
    thread::spawn(move || {
        let result = Command::new(&program_for_thread).args(&args).output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!(
                "{} did not finish within {}s",
                program.display(),
                timeout.as_secs()
            ),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    struct TestBackupRoot(PathBuf);

    #[cfg(target_os = "macos")]
    impl TestBackupRoot {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("test clock must be after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "privacytracker-cfgutil-test-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create test backup root");
            Self(path)
        }
    }

    #[cfg(target_os = "macos")]
    impl Drop for TestBackupRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parse_ecids_reads_cfgutil_output_keys() {
        let ecids = parse_ecids(r#"{"Output":{"ABC123":{"name":"iPhone"},"DEF456":{}}}"#);

        assert_eq!(ecids, vec!["ABC123".to_string(), "DEF456".to_string()]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parse_installed_apps_prefers_display_name_and_dedupes_by_bundle_id() {
        let rows = parse_installed_apps(
            r#"{
              "Output": {
                "ABC123": {
                  "installedApps": [
                    {
                      "displayName": "Clock",
                      "itunesName": "Clock by Apple",
                      "bundleIdentifier": "com.apple.mobiletimer",
                      "bundleVersion": "1"
                    },
                    {
                      "displayName": "Signal",
                      "bundleIdentifier": "org.whispersystems.signal",
                      "bundleShortVersion": "7.0"
                    }
                  ]
                },
                "DEF456": {
                  "installedApps": [
                    {
                      "displayName": "Clock duplicate",
                      "bundleIdentifier": "com.apple.mobiletimer"
                    }
                  ]
                }
              }
            }"#,
        );

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "Clock");
        assert_eq!(rows[0].bundle_id.as_deref(), Some("com.apple.mobiletimer"));
        assert_eq!(rows[1].name, "Signal");
        assert_eq!(rows[1].version.as_deref(), Some("7.0"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parse_device_info_falls_back_to_bare_ecid() {
        let rows = parse_device_info(
            r#"{"Output":{"ABC123":{"name":"Ada's iPhone","model":"iPhone15,3","OSVersion":"17.4","deviceClass":"iPhone"}}}"#,
            &["ABC123".to_string(), "MISSING".to_string()],
        );

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name.as_deref(), Some("Ada's iPhone"));
        assert_eq!(rows[0].ios_version.as_deref(), Some("17.4"));
        assert_eq!(rows[1].ecid, "MISSING");
        assert!(rows[1].name.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn backup_scan_requires_a_non_empty_regular_manifest() {
        let root = TestBackupRoot::new();
        let complete = root.0.join("complete-udid");
        let empty = root.0.join("empty-udid");
        let missing = root.0.join("missing-udid");
        std::fs::create_dir_all(&complete).unwrap();
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&missing).unwrap();
        std::fs::write(complete.join("Manifest.db"), b"sqlite fixture").unwrap();
        std::fs::write(empty.join("Manifest.db"), b"").unwrap();

        let scanned = scan_verified_backups(&root.0).unwrap();
        assert_eq!(scanned.len(), 1);
        assert!(scanned.contains_key(&complete.canonicalize().unwrap()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn changed_backup_discovery_rejects_unchanged_and_old_candidates() {
        let started_at = SystemTime::now();
        let recent_path = PathBuf::from("/tmp/recent-backup");
        let old_path = PathBuf::from("/tmp/old-backup");
        let recent_before = BackupSignature {
            directory_modified: Some(started_at),
            manifest_bytes: 10,
            manifest_modified: Some(started_at),
        };
        let recent_after = BackupSignature {
            directory_modified: Some(started_at),
            manifest_bytes: 20,
            manifest_modified: Some(started_at),
        };
        let old_time = started_at
            .checked_sub(Duration::from_secs(60))
            .expect("test clock supports subtraction");
        let old_after = BackupSignature {
            directory_modified: Some(old_time),
            manifest_bytes: 20,
            manifest_modified: Some(old_time),
        };

        let before = HashMap::from([(recent_path.clone(), recent_before.clone())]);
        let after = HashMap::from([(recent_path.clone(), recent_after), (old_path, old_after)]);
        assert_eq!(
            find_changed_verified_backup(&before, &after, started_at, "recent-backup"),
            Some(recent_path.clone())
        );
        assert_eq!(
            find_changed_verified_backup(
                &HashMap::from([(recent_path.clone(), recent_before.clone())]),
                &HashMap::from([(recent_path, recent_before)]),
                started_at,
                "recent-backup"
            ),
            None
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn backup_identity_requires_the_selected_ecid_and_a_safe_udid() {
        let json = r#"{"Output":{"0xABCDEF123456":{"UDID":"00008110-001234567890ABCD"}}}"#;
        assert_eq!(
            parse_backup_udid(json, "abcdef123456").as_deref(),
            Some("00008110-001234567890ABCD")
        );
        assert!(parse_backup_udid(json, "111122223333").is_none());
        assert!(parse_backup_udid(
            r#"{"Output":{"0xABCDEF123456":{"UDID":"../../another-device"}}}"#,
            "ABCDEF123456"
        )
        .is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn backup_discovery_rejects_other_devices_and_future_files() {
        let now = SystemTime::now();
        let path = PathBuf::from("/tmp/selected-device");
        let signature = BackupSignature {
            directory_modified: Some(now),
            manifest_bytes: 20,
            manifest_modified: Some(now),
        };
        let after = HashMap::from([(path.clone(), signature.clone())]);
        assert!(
            find_changed_verified_backup(&HashMap::new(), &after, now, "other-device").is_none()
        );
        let future = BackupSignature {
            manifest_modified: Some(now + Duration::from_secs(3600)),
            ..signature
        };
        let after = HashMap::from([(path, future)]);
        assert!(
            find_changed_verified_backup(&HashMap::new(), &after, now, "selected-device").is_none()
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_cfgutil_commands_return_structured_unavailable_results() {
        let check = detect_cfgutil_impl();

        assert!(!check.available);
        assert!(check.error.unwrap().contains("macOS-only"));
        assert!(run_cfgutil_export_impl(None)
            .unwrap_err()
            .contains("macOS-only"));
        assert!(list_connected_devices_impl().cfgutil_unavailable);
    }
}
