// "Copy diagnostics report" payload builder.
//
// Goal: one button the user clicks (or one path they can paste into an
// issue) that captures every piece of state we reasonably need to debug a
// report like "my sync stopped working" without dragging the user through a
// 10-step reproduction.
//
// We pull:
//   - app version + build target from Cargo metadata at compile time
//   - OS name + version via std::env + sysctl-style probes
//   - data dir path (the one we passed to the sidecar)
//   - sidecar URL + last-known /api/apps reachability
//   - an arbitrary JSON blob from /api/desktop/diagnostics (node version,
//     last sync timestamps, pending bulk runs, etc. — the node side owns
//     its own diagnostics because only it knows those).
//
// The result is a human-readable string. The UI button does
// navigator.clipboard.writeText(...) with it.

use std::time::Duration;

use serde_json::Value;

pub fn build_report(base_url: &str) -> String {
    let mut out = String::new();
    out.push_str("privacytracker diagnostics report\n");
    out.push_str(&format!("Generated: {}\n", chrono_like_now()));
    out.push_str("-- App --\n");
    out.push_str(&format!("  Version:       {}\n", env!("CARGO_PKG_VERSION")));
    out.push_str(&format!("  Target:        {}\n", target_triple()));
    out.push_str(&format!("  Debug build:   {}\n", cfg!(debug_assertions)));
    out.push_str("-- OS --\n");
    out.push_str(&format!("  Family:        {}\n", std::env::consts::FAMILY));
    out.push_str(&format!("  OS:            {}\n", std::env::consts::OS));
    out.push_str(&format!("  Arch:          {}\n", std::env::consts::ARCH));
    out.push_str("-- Sidecar --\n");
    out.push_str(&format!("  Base URL:      {}\n", base_url));
    out.push_str(&format!("  Data dir:      {}\n", data_dir_display()));

    // Liveness probe.
    let probe = match ureq::get(&format!("{base_url}/api/apps"))
        .timeout(Duration::from_secs(3))
        .call()
    {
        Ok(r) => format!("HTTP {}", r.status()),
        Err(e) => format!("ERROR {e}"),
    };
    out.push_str(&format!("  /api/apps:     {probe}\n"));

    // Node-side payload. Never fatal — if the route isn't implemented yet
    // we note it and move on.
    out.push_str("-- Node side --\n");
    match fetch_node_diagnostics(base_url) {
        Ok(json) => {
            let pretty = serde_json::to_string_pretty(&json)
                .unwrap_or_else(|_| json.to_string());
            for line in pretty.lines() {
                out.push_str("  ");
                out.push_str(line);
                out.push('\n');
            }
        }
        Err(e) => {
            out.push_str(&format!("  /api/desktop/diagnostics unavailable: {e}\n"));
        }
    }

    out
}

fn fetch_node_diagnostics(base_url: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let json: Value = ureq::get(&format!("{base_url}/api/desktop/diagnostics"))
        .timeout(Duration::from_secs(5))
        .call()?
        .into_json()?;
    Ok(json)
}

fn target_triple() -> &'static str {
    // Cargo sets TARGET during build script runs but not for the main crate.
    // Fall back to a derived string from the cfg. We don't need forensic
    // precision here — "macOS arm64" is enough context for a bug report.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))] { "aarch64-apple-darwin" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]  { "x86_64-apple-darwin" }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))] { "x86_64-pc-windows-msvc" }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))] { "x86_64-unknown-linux-gnu" }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
    )))] { "unknown" }
}

fn data_dir_display() -> String {
    dirs::data_dir()
        .map(|p| p.join("privacytracker").display().to_string())
        .unwrap_or_else(|| "<unresolved>".to_string())
}

/// Avoid pulling in chrono as a dep just for one timestamp string. Format
/// SystemTime as an ISO-ish UTC string.
fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    // epoch seconds → "YYYY-MM-DDTHH:MM:SSZ". We only need coarse
    // granularity — the sidecar's activity log is the precise timestamp.
    let secs = dur.as_secs() as i64;
    format_epoch(secs)
}

// Gregorian conversion cribbed from the classic Howard Hinnant algorithm —
// simpler than pulling a full datetime crate into a desktop shell.
fn format_epoch(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;

    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, hh, mm, ss
    )
}
