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
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "macos")]
use std::time::Duration;

use serde::Serialize;
#[cfg(target_os = "macos")]
use serde_json::Value;

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
#[derive(Debug, Serialize, Default)]
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
pub fn check_cfgutil() -> CfgutilCheck {
    detect_cfgutil_impl()
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
        FALLBACK_CFGUTIL_PATHS.iter().map(|p| (*p).to_string()).collect()
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
                out.path = Some(candidate);
                return out;
            }
            Ok(list_output) => {
                let stdout = String::from_utf8_lossy(&list_output.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&list_output.stderr).trim().to_string();
                let detail = if stderr.is_empty() { stdout } else { stderr };
                let detail_lower = detail.to_lowercase();
                if detail_lower.contains("no devices")
                    || detail_lower.contains("no connected devices")
                {
                    out.available = true;
                    out.version = detect_cfgutil_version(&candidate);
                    out.path = Some(candidate);
                    return out;
                }
                out.error = Some(format!(
                    "cfgutil at {} did not pass the device-list check ({}): {}",
                    candidate,
                    list_output.status,
                    detail
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

#[cfg(target_os = "macos")]
fn detect_cfgutil_version(candidate: &str) -> Option<String> {
    let probes: &[&[&str]] = &[&["version"], &["--version"], &["-v"]];
    for args in probes {
        let Ok(output) = run_with_timeout(Command::new(candidate).args(*args), Duration::from_secs(3)) else {
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
    if path.is_empty() { None } else { Some(path) }
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
pub fn run_cfgutil_export(ecid: Option<String>) -> Result<CfgutilExport, String> {
    run_cfgutil_export_impl(ecid)
}

#[cfg(target_os = "macos")]
fn run_cfgutil_export_impl(ecid: Option<String>) -> Result<CfgutilExport, String> {
    let check = detect_cfgutil_impl();
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
    let mut apps_args: Vec<String> = vec![
        "--format".to_string(),
        "JSON".to_string(),
    ];
    if let Some(ref e) = ecid {
        // Defence in depth — refuse anything that doesn't look like a
        // hex-style ECID. cfgutil treats `--ecid foo` permissively; we
        // don't.
        if e.chars().any(|c| !c.is_ascii_alphanumeric()) {
            return Err(format!("Refusing to scope export — ECID has unexpected characters: {e}"));
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
            if apps_stderr.is_empty() { &apps_stdout } else { &apps_stderr }
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
pub fn list_connected_devices() -> ConnectedDeviceList {
    list_connected_devices_impl()
}

#[cfg(target_os = "macos")]
fn list_connected_devices_impl() -> ConnectedDeviceList {
    let check = detect_cfgutil_impl();
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
    /// True iff cfgutil exited 0. Backup files are large and Configurator
    /// occasionally fails mid-stream (low disk space, device rebooted,
    /// passcode required) — the webview shows different copy per state.
    pub ok: bool,

    /// ECID the backup ran against. Echoed back so the caller can
    /// match the response to the request without holding state.
    pub ecid: String,

    /// Filesystem path the backup landed at when ok=true. NULL on
    /// failure or when cfgutil's stdout didn't surface a path (older
    /// builds wrote it elsewhere; we fall back to the requested
    /// `dest_dir` in that case).
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

/// Run `cfgutil --device-id <ecid> backup --backup-output <dest>`. The
/// caller passes a destination directory the backup should land in;
/// the Rust side adds nothing extra — the path stays exactly where
/// the user (or sidecar) tells it to.
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
pub fn run_cfgutil_backup(ecid: String, dest_dir: String) -> CfgutilBackupResult {
    run_cfgutil_backup_impl(ecid, dest_dir)
}

#[cfg(target_os = "macos")]
fn run_cfgutil_backup_impl(ecid: String, dest_dir: String) -> CfgutilBackupResult {
    let mut out = CfgutilBackupResult {
        ecid: ecid.clone(),
        ..Default::default()
    };

    let check = detect_cfgutil_impl();
    if !check.available {
        out.error = Some(check.error.unwrap_or_else(|| "cfgutil not available".to_string()));
        return out;
    }
    let cfgutil_path = check.path.unwrap_or_else(|| "cfgutil".to_string());

    // Make sure dest_dir exists — cfgutil's behaviour is undefined if
    // the parent doesn't exist. Best-effort create; permission errors
    // surface through cfgutil itself rather than confusing the caller
    // with two layers of "couldn't make dir".
    let _ = std::fs::create_dir_all(&dest_dir);

    // 5-minute ceiling. Real-world iCloud-light backups land in 30-90s;
    // a media-heavy phone can stretch to 4-5 minutes on USB-2 hardware.
    // Anything past 5 minutes is almost certainly a stuck pairing prompt
    // (the device is asking for a passcode the user hasn't typed) — we
    // surface that as a timeout rather than letting the wizard hang.
    let result = run_with_timeout(
        Command::new(&cfgutil_path).args([
            "--ecid",
            &ecid,
            "--format",
            "JSON",
            "backup",
            "--backup-output",
            &dest_dir,
        ]),
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
    out.log = if !stdout.is_empty() { stdout.clone() } else { stderr.clone() };

    if !output.status.success() {
        out.error = Some(format!(
            "cfgutil backup exited non-zero ({}): {}",
            output.status,
            if stderr.is_empty() { &stdout } else { &stderr }
        ));
        return out;
    }

    // Try to extract the backup path from cfgutil's JSON output. The
    // shape varies between cfgutil versions; we look in a few places
    // before falling back to "the dest_dir we asked for".
    let backup_path = serde_json::from_str::<Value>(&stdout)
        .ok()
        .and_then(|v| {
            v.pointer("/Output")
                .and_then(|out| out.as_object())
                .and_then(|map| map.values().next().cloned())
                .and_then(|device_value| {
                    first_non_empty_string(&device_value, &["backupPath", "path", "destination"])
                })
        })
        .unwrap_or(dest_dir);

    out.ok = true;
    out.backup_path = Some(backup_path);
    out.finished_at = Some(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    );
    out
}

#[cfg(not(target_os = "macos"))]
fn run_cfgutil_backup_impl(ecid: String, _dest_dir: String) -> CfgutilBackupResult {
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
pub fn run_cfgutil_remove_app(ecid: String, bundle_id: String) -> CfgutilRemoveResult {
    run_cfgutil_remove_app_impl(ecid, bundle_id)
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

    let check = detect_cfgutil_impl();
    if !check.available {
        out.error = Some(check.error.unwrap_or_else(|| "cfgutil not available".to_string()));
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
    out.log = if !stdout.is_empty() { stdout.clone() } else { stderr.clone() };

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
            let ios_version = entry.and_then(|e| {
                first_non_empty_string(e, &["OSVersion", "osVersion"])
            });
            let device_class = entry.and_then(|e| {
                first_non_empty_string(e, &["deviceClass", "deviceType"])
            });
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
    let bundle_id = first_non_empty_string(entry, &["bundleIdentifier", "bundleId", "CFBundleIdentifier"]);
    let version = first_non_empty_string(
        entry,
        &["bundleShortVersion", "shortVersion", "version", "bundleVersion", "CFBundleShortVersionString"],
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
    let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();

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

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_cfgutil_commands_return_structured_unavailable_results() {
        let check = detect_cfgutil_impl();

        assert!(!check.available);
        assert!(check.error.unwrap().contains("macOS-only"));
        assert!(run_cfgutil_export_impl(None).unwrap_err().contains("macOS-only"));
        assert!(list_connected_devices_impl().cfgutil_unavailable);
    }
}
