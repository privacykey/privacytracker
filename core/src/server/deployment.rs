//! Port of `lib/deployment-diagnostics.ts` — `buildDeploymentDiagnostics`,
//! the payload behind `GET /api/deployment/diagnostics` and the readiness
//! verdict behind `GET /api/ready`.
//!
//! Almost everything here is a fact about the deployment rather than the
//! database: the process env, the data directory's permissions, the request's
//! forwarded headers, the host OS. Two of those facts differ between a Node
//! process and this one by definition and are handled explicitly:
//!
//! - **`app.node`** is `process.version`. This server has no Node; it
//!   answers with its own identity (`pt-core <version>`). The parity
//!   manifest masks the field, and it is the ONLY field in this payload it
//!   masks for that reason.
//! - **`app.nodeEnv`** is `process.env.NODE_ENV ?? "development"`, and
//!   `next start` sets it to `production` inside the process. Here the env
//!   var wins when set, else a release build reports `production` and a
//!   debug build `development` — the same distinction `next start` /
//!   `next dev` draws. The parity harness passes `NODE_ENV=production`.
//!
//! Everything else is reproduced, including the two things that are easy
//! to skip: `app.name`/`version` come from the repo's `package.json`,
//! embedded at build time, not from `Cargo.toml`; and `network` is read
//! AFTER `forwarded.rs` has done what `next start` does to the headers, so
//! `proxyDetected` is true on a direct request exactly as it is in Node.

use std::path::{Path, PathBuf};

use axum::http::HeaderMap;
use rusqlite::OptionalExtension;
use serde::Serialize;

use super::auth::admin_token_configured;
use super::osinfo::{access_read_write, home_dir, likely_container, node_arch, platform_string};
use super::settings::get_setting_with;
use super::trust::{
    allowed_host_patterns, bind_is_ambiguous, is_loopback_normalized, is_network_exposed,
    normalize_host, trust_proxy,
};
use super::AppState;
use crate::jsdate::js_iso_string;

/// `package.json`, embedded so `app.name` / `app.version` are the app's, not
/// the crate's. Parsed once per request; the file is a few kilobytes.
const PACKAGE_JSON: &str = include_str!("../../../package.json");

fn package_field(key: &str) -> String {
    serde_json::from_str::<serde_json::Value>(PACKAGE_JSON)
        .ok()
        .and_then(|v| v.get(key).and_then(|s| s.as_str()).map(str::to_string))
        .unwrap_or_default()
}

/// `redactHomeDir`: `~` for the home directory itself, `~/…` beneath it,
/// untouched otherwise — and untouched when the home directory is unknown
/// or is the filesystem root.
pub fn redact_home_dir(p: &str) -> String {
    let Some(home) = home_dir() else {
        return p.to_string();
    };
    if home.is_empty() || home == "/" || home == "\\" {
        return p.to_string();
    }
    if p == home {
        return "~".to_string();
    }
    if p.starts_with(&format!("{home}/")) || p.starts_with(&format!("{home}\\")) {
        return format!("~{}", &p[home.len()..]);
    }
    p.to_string()
}

/// `firstHeaderValue`: Next's `Headers.get` joins repeated headers with
/// `", "`; the first comma-separated segment, trimmed, or null when empty.
fn first_header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(name)?.to_str().ok()?;
    let first = raw.split(',').next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

/// `isLocalOnlyHost` → `isLoopbackHost`: normalise, then the loopback test.
fn is_local_only_host(host: Option<&str>) -> bool {
    normalize_host(host)
        .map(|h| is_loopback_normalized(&h))
        .unwrap_or(false)
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct NetworkDiagnostics {
    pub host: Option<String>,
    #[serde(rename = "forwardedHost")]
    pub forwarded_host: Option<String>,
    #[serde(rename = "forwardedProto")]
    pub forwarded_proto: Option<String>,
    #[serde(rename = "forwardedForPresent")]
    pub forwarded_for_present: bool,
    #[serde(rename = "realIpPresent")]
    pub real_ip_present: bool,
    #[serde(rename = "proxyDetected")]
    pub proxy_detected: bool,
    pub protocol: &'static str,
    #[serde(rename = "localOnlyHost")]
    pub local_only_host: bool,
    #[serde(rename = "lanOrDomainHost")]
    pub lan_or_domain_host: bool,
}

/// `inferDeploymentNetwork(headers)`. Note `effectiveHost` prefers the
/// forwarded host UNCONDITIONALLY — this is diagnostics, not the gate, and
/// it reports what a proxy claims rather than what is trusted.
pub fn infer_deployment_network(headers: &HeaderMap) -> NetworkDiagnostics {
    let direct_host = first_header_value(headers, "host");
    let forwarded_host = first_header_value(headers, "x-forwarded-host");
    let forwarded_proto = first_header_value(headers, "x-forwarded-proto");
    let forwarded_for = first_header_value(headers, "x-forwarded-for");
    let real_ip = first_header_value(headers, "x-real-ip");
    let forwarded_port = first_header_value(headers, "x-forwarded-port");
    let forwarded_ssl = first_header_value(headers, "x-forwarded-ssl");

    let effective_host = forwarded_host.clone().or(direct_host);
    let proxy_detected = forwarded_host.is_some()
        || forwarded_proto.is_some()
        || forwarded_for.is_some()
        || real_ip.is_some()
        || forwarded_port.is_some()
        || forwarded_ssl.is_some();
    let protocol =
        if forwarded_proto.as_deref() == Some("https") || forwarded_ssl.as_deref() == Some("on") {
            "https"
        } else if forwarded_proto.as_deref() == Some("http") {
            "http"
        } else {
            "unknown"
        };
    let local_only_host = is_local_only_host(effective_host.as_deref());
    let lan_or_domain_host = effective_host.is_some() && !local_only_host;

    NetworkDiagnostics {
        host: effective_host,
        forwarded_host,
        forwarded_proto,
        forwarded_for_present: forwarded_for.is_some(),
        real_ip_present: real_ip.is_some(),
        proxy_detected,
        protocol,
        local_only_host,
        lan_or_domain_host,
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct HealthDiagnostics {
    pub status: &'static str,
    #[serde(rename = "dbPingMs")]
    pub db_ping_ms: Option<i64>,
    pub error: Option<String>,
}

/// `readHealth`: `SELECT 1 AS ok`, timed. `dbPingMs` is never null on this
/// path — the type allows it for a shape shared elsewhere.
fn read_health(conn: &rusqlite::Connection) -> HealthDiagnostics {
    let started = std::time::Instant::now();
    let elapsed = || started.elapsed().as_millis() as i64;
    match conn
        .query_row("SELECT 1 AS ok", [], |r| r.get::<_, i64>(0))
        .optional()
    {
        Ok(Some(1)) => HealthDiagnostics {
            status: "ok",
            db_ping_ms: Some(elapsed()),
            error: None,
        },
        Ok(_) => HealthDiagnostics {
            status: "degraded",
            db_ping_ms: Some(elapsed()),
            error: Some("Database ping returned an unexpected result.".to_string()),
        },
        Err(e) => HealthDiagnostics {
            status: "degraded",
            db_ping_ms: Some(elapsed()),
            error: Some(e.to_string()),
        },
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DatabaseDiagnostics {
    pub path: String,
    #[serde(rename = "dataDir")]
    pub data_dir: String,
    #[serde(rename = "dataDirSource")]
    pub data_dir_source: &'static str,
    pub exists: bool,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: Option<u64>,
    pub writable: bool,
    #[serde(rename = "journalMode")]
    pub journal_mode: Option<String>,
    pub error: Option<String>,
}

/// `readDatabase`. The `:memory:` arm is Node's build-phase case and has no
/// counterpart here; `dataDirSource` is therefore `env` or `cwd`.
fn read_database(
    conn: &rusqlite::Connection,
    db_path: &Path,
    data_dir: &Path,
    source: &'static str,
) -> DatabaseDiagnostics {
    let exists = db_path.exists();
    let writable_target: &Path = if exists { db_path } else { data_dir };
    let (writable, access_error) = match access_read_write(writable_target) {
        Ok(()) => (true, None),
        Err(msg) => (false, Some(msg)),
    };
    let journal_mode = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
        .ok();
    DatabaseDiagnostics {
        path: redact_home_dir(&db_path.display().to_string()),
        data_dir: redact_home_dir(&data_dir.display().to_string()),
        data_dir_source: source,
        exists,
        size_bytes: if exists {
            std::fs::metadata(db_path).ok().map(|m| m.len())
        } else {
            None
        },
        writable,
        journal_mode,
        error: access_error,
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SecurityDiagnostics {
    #[serde(rename = "adminTokenConfigured")]
    pub admin_token_configured: bool,
    #[serde(rename = "adminTokenRequired")]
    pub admin_token_required: bool,
    #[serde(rename = "allowedHostsConfigured")]
    pub allowed_hosts_configured: bool,
    #[serde(rename = "bindAmbiguous")]
    pub bind_ambiguous: bool,
    #[serde(rename = "networkExposed")]
    pub network_exposed: bool,
    #[serde(rename = "trustProxy")]
    pub trust_proxy: bool,
}

fn read_security() -> SecurityDiagnostics {
    SecurityDiagnostics {
        admin_token_configured: admin_token_configured(),
        admin_token_required: admin_token_configured() || is_network_exposed(),
        allowed_hosts_configured: !allowed_host_patterns().is_empty(),
        bind_ambiguous: bind_is_ambiguous(),
        network_exposed: is_network_exposed(),
        trust_proxy: trust_proxy(),
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DeploymentCheck {
    pub id: &'static str,
    pub label: &'static str,
    pub status: &'static str,
    pub detail: String,
}

/// `buildChecks`: five verdicts, every string verbatim from the Node source.
pub fn build_checks(
    health: &HealthDiagnostics,
    database: &DatabaseDiagnostics,
    network: &NetworkDiagnostics,
    security: &SecurityDiagnostics,
) -> Vec<DeploymentCheck> {
    vec![
        DeploymentCheck {
            id: "health",
            label: "App health",
            status: if health.status == "ok" { "ok" } else { "bad" },
            detail: if health.status == "ok" {
                format!(
                    "Health probe is passing ({}ms DB ping).",
                    health.db_ping_ms.unwrap_or(0)
                )
            } else {
                health
                    .error
                    .clone()
                    .unwrap_or_else(|| "Health probe failed.".to_string())
            },
        },
        DeploymentCheck {
            id: "database",
            label: "Database storage",
            status: if database.writable { "ok" } else { "bad" },
            detail: if database.writable {
                format!("SQLite is writable at {}.", database.path)
            } else {
                database
                    .error
                    .clone()
                    .unwrap_or_else(|| format!("SQLite is not writable at {}.", database.path))
            },
        },
        DeploymentCheck {
            id: "proxy",
            label: "Proxy detection",
            status: if network.proxy_detected {
                "ok"
            } else if network.lan_or_domain_host {
                "warn"
            } else {
                "info"
            },
            detail: if network.proxy_detected {
                "Forwarded proxy headers are present.".to_string()
            } else if network.lan_or_domain_host {
                "This looks LAN/domain reachable, but no forwarded proxy headers were seen."
                    .to_string()
            } else {
                "No proxy headers seen on this local-only request.".to_string()
            },
        },
        DeploymentCheck {
            id: "transport",
            label: "Transport",
            status: if network.protocol == "https" || network.local_only_host {
                "ok"
            } else {
                "warn"
            },
            detail: if network.protocol == "https" {
                "The request arrived through HTTPS.".to_string()
            } else if network.local_only_host {
                "Localhost access is fine over HTTP.".to_string()
            } else {
                "Use HTTPS for LAN access to protect your access token and private data."
                    .to_string()
            },
        },
        DeploymentCheck {
            id: "admin-token",
            label: "Private data access",
            status: if security.admin_token_configured {
                "ok"
            } else if security.admin_token_required {
                "bad"
            } else {
                "info"
            },
            detail: if security.admin_token_configured {
                "AUDITOR_ADMIN_TOKEN is configured for private pages and API calls.".to_string()
            } else if security.admin_token_required {
                "This deployment is declared network-exposed, so private pages and API calls are refused until AUDITOR_ADMIN_TOKEN is set.".to_string()
            } else if security.bind_ambiguous {
                "AUDITOR_ADMIN_TOKEN is optional for localhost-only access. This instance may bind a non-loopback interface (e.g. inside Docker) — if it is reachable beyond localhost, set AUDITOR_ADMIN_TOKEN and PRIVACYTRACKER_ALLOWED_HOSTS.".to_string()
            } else {
                "AUDITOR_ADMIN_TOKEN is optional for localhost-only access.".to_string()
            },
        },
    ]
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AppDiagnostics {
    pub name: String,
    pub version: String,
    #[serde(rename = "nodeEnv")]
    pub node_env: String,
    pub runtime: &'static str,
    #[serde(rename = "containerLikely")]
    pub container_likely: bool,
    pub platform: String,
    pub arch: &'static str,
    pub node: String,
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: u64,
}

/// `DeploymentDiagnostics`, fields in the literal's order.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DeploymentDiagnostics {
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    pub app: AppDiagnostics,
    pub health: HealthDiagnostics,
    pub database: DatabaseDiagnostics,
    pub network: NetworkDiagnostics,
    pub security: SecurityDiagnostics,
    pub checks: Vec<DeploymentCheck>,
}

/// `process.env.NODE_ENV ?? "development"`, with the build profile standing
/// in for what `next start` / `next dev` would have set.
fn node_env() -> String {
    match std::env::var("NODE_ENV") {
        Ok(v) if !v.is_empty() => v,
        _ if cfg!(debug_assertions) => "development".to_string(),
        _ => "production".to_string(),
    }
}

/// `buildDeploymentDiagnostics(headers)`, with the connection lock held.
pub fn build_deployment_diagnostics(
    state: &AppState,
    conn: &rusqlite::Connection,
    headers: &HeaderMap,
) -> rusqlite::Result<DeploymentDiagnostics> {
    let runtime = if get_setting_with(conn, "runtime_environment", "")? == "desktop" {
        "desktop"
    } else {
        "web"
    };
    let health = read_health(conn);
    let database = read_database(conn, &state.db_path, &state.data_dir, state.data_dir_source);
    let network = infer_deployment_network(headers);
    let security = read_security();
    let checks = build_checks(&health, &database, &network, &security);
    Ok(DeploymentDiagnostics {
        generated_at: js_iso_string(super::now_ms()),
        app: AppDiagnostics {
            name: package_field("name"),
            version: package_field("version"),
            node_env: node_env(),
            runtime,
            container_likely: likely_container(),
            platform: platform_string(),
            arch: node_arch(),
            node: format!("pt-core {}", env!("CARGO_PKG_VERSION")),
            uptime_seconds: state.started_at.elapsed().as_secs_f64().round() as u64,
        },
        health,
        database,
        network,
        security,
        checks,
    })
}

/// `/api/ready`'s verdict: `health.status === "ok" && database.writable`.
pub fn is_ready(d: &DeploymentDiagnostics) -> bool {
    d.health.status == "ok" && d.database.writable
}

/// `path.resolve(p)`: absolute against the current directory, `.` and `..`
/// folded, symlinks NOT resolved (Node does not canonicalise either).
pub fn resolve_path(p: &Path) -> PathBuf {
    use std::path::Component;
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(p)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn network_inference_matches_the_three_node_probes() {
        // What the running Node server answered, AFTER next start's header
        // synthesis (host, proto and for present; real-ip not).
        let plain = infer_deployment_network(&headers(&[
            ("host", "127.0.0.1:3001"),
            ("x-forwarded-host", "127.0.0.1:3001"),
            ("x-forwarded-proto", "http"),
            ("x-forwarded-for", "127.0.0.1"),
            ("x-forwarded-port", "3001"),
        ]));
        assert_eq!(
            plain,
            NetworkDiagnostics {
                host: Some("127.0.0.1:3001".into()),
                forwarded_host: Some("127.0.0.1:3001".into()),
                forwarded_proto: Some("http".into()),
                forwarded_for_present: true,
                real_ip_present: false,
                proxy_detected: true,
                protocol: "http",
                local_only_host: true,
                lan_or_domain_host: false,
            }
        );
        // Forged proto + host are believed verbatim: this is diagnostics.
        let forged = infer_deployment_network(&headers(&[
            ("host", "127.0.0.1:3001"),
            ("x-forwarded-host", "evil.example:9"),
            ("x-forwarded-proto", "https"),
            ("x-forwarded-for", "127.0.0.1"),
        ]));
        assert_eq!(forged.host.as_deref(), Some("evil.example:9"));
        assert_eq!(forged.protocol, "https");
        assert!(!forged.local_only_host);
        assert!(forged.lan_or_domain_host);
        // x-real-ip flips only its own flag.
        let real_ip = infer_deployment_network(&headers(&[
            ("host", "127.0.0.1:3001"),
            ("x-forwarded-host", "127.0.0.1:3001"),
            ("x-forwarded-proto", "http"),
            ("x-forwarded-for", "127.0.0.1"),
            ("x-real-ip", "10.0.0.9"),
        ]));
        assert!(real_ip.real_ip_present);
        assert!(real_ip.proxy_detected);
    }

    #[test]
    fn a_raw_request_with_no_forwarded_headers_is_what_next_never_shows() {
        // Without forwarded.rs this is what the route would see — and
        // what Node's route never does.
        let raw = infer_deployment_network(&headers(&[("host", "localhost:3000")]));
        assert!(!raw.proxy_detected);
        assert_eq!(raw.protocol, "unknown");
        assert_eq!(raw.forwarded_host, None);
        assert!(raw.local_only_host);
        // Repeated headers: the FIRST value's first comma segment wins;
        // an empty first segment is null.
        let multi = infer_deployment_network(&headers(&[
            ("host", "a.example, b.example"),
            ("x-forwarded-proto", " , https"),
        ]));
        assert_eq!(multi.host.as_deref(), Some("a.example"));
        assert_eq!(multi.forwarded_proto, None);
        // An empty first segment is absent — and with nothing else forwarded,
        // no proxy is detected.
        assert!(!multi.proxy_detected);
    }

    #[test]
    fn empty_forwarded_header_is_absent_not_present() {
        let h =
            infer_deployment_network(&headers(&[("host", "localhost"), ("x-forwarded-for", "")]));
        assert!(!h.forwarded_for_present);
        assert!(!h.proxy_detected);
    }

    #[test]
    fn checks_cover_every_branch() {
        let ok_health = HealthDiagnostics {
            status: "ok",
            db_ping_ms: Some(3),
            error: None,
        };
        let bad_health = HealthDiagnostics {
            status: "degraded",
            db_ping_ms: Some(0),
            error: Some("boom".into()),
        };
        let db = |writable: bool, error: Option<&str>| DatabaseDiagnostics {
            path: "~/x/privacy.db".into(),
            data_dir: "~/x".into(),
            data_dir_source: "env",
            exists: true,
            size_bytes: Some(1),
            writable,
            journal_mode: Some("wal".into()),
            error: error.map(str::to_string),
        };
        let net =
            |proxy: bool, lan: bool, protocol: &'static str, local: bool| NetworkDiagnostics {
                host: Some("h".into()),
                forwarded_host: None,
                forwarded_proto: None,
                forwarded_for_present: false,
                real_ip_present: false,
                proxy_detected: proxy,
                protocol,
                local_only_host: local,
                lan_or_domain_host: lan,
            };
        let sec = |configured: bool, required: bool, ambiguous: bool| SecurityDiagnostics {
            admin_token_configured: configured,
            admin_token_required: required,
            allowed_hosts_configured: false,
            bind_ambiguous: ambiguous,
            network_exposed: required,
            trust_proxy: false,
        };

        let c = build_checks(
            &ok_health,
            &db(true, None),
            &net(true, false, "http", true),
            &sec(true, true, false),
        );
        assert_eq!(c.len(), 5);
        assert_eq!(c[0].detail, "Health probe is passing (3ms DB ping).");
        assert_eq!(c[1].detail, "SQLite is writable at ~/x/privacy.db.");
        assert_eq!(
            (c[2].status, c[2].detail.as_str()),
            ("ok", "Forwarded proxy headers are present.")
        );
        assert_eq!(
            (c[3].status, c[3].detail.as_str()),
            ("ok", "Localhost access is fine over HTTP.")
        );
        assert_eq!(c[4].status, "ok");

        let c = build_checks(
            &bad_health,
            &db(false, None),
            &net(false, true, "unknown", false),
            &sec(false, true, false),
        );
        assert_eq!((c[0].status, c[0].detail.as_str()), ("bad", "boom"));
        assert_eq!(
            (c[1].status, c[1].detail.as_str()),
            ("bad", "SQLite is not writable at ~/x/privacy.db.")
        );
        assert_eq!(c[2].status, "warn");
        assert_eq!(
            (c[3].status, c[3].detail.as_str()),
            (
                "warn",
                "Use HTTPS for LAN access to protect your access token and private data."
            )
        );
        assert_eq!(c[4].status, "bad");

        let c = build_checks(
            &ok_health,
            &db(false, Some("EACCES: permission denied, access '/x'")),
            &net(false, false, "https", false),
            &sec(false, false, true),
        );
        assert_eq!(c[1].detail, "EACCES: permission denied, access '/x'");
        assert_eq!(
            (c[2].status, c[2].detail.as_str()),
            ("info", "No proxy headers seen on this local-only request.")
        );
        assert_eq!(
            (c[3].status, c[3].detail.as_str()),
            ("ok", "The request arrived through HTTPS.")
        );
        assert_eq!(c[4].status, "info");
        assert!(c[4].detail.contains("may bind a non-loopback interface"));

        let c = build_checks(
            &ok_health,
            &db(true, None),
            &net(false, false, "unknown", true),
            &sec(false, false, false),
        );
        assert_eq!(
            c[4].detail,
            "AUDITOR_ADMIN_TOKEN is optional for localhost-only access."
        );
    }

    #[test]
    fn home_dir_redaction() {
        let Some(home) = home_dir() else { return };
        if home == "/" {
            return;
        }
        assert_eq!(redact_home_dir(&home), "~");
        assert_eq!(
            redact_home_dir(&format!("{home}/data/privacy.db")),
            "~/data/privacy.db"
        );
        // A sibling that merely shares the prefix is left alone.
        assert_eq!(redact_home_dir(&format!("{home}2/x")), format!("{home}2/x"));
        assert_eq!(redact_home_dir("/private/tmp/x"), "/private/tmp/x");
    }

    #[test]
    fn resolve_path_folds_dots_without_touching_symlinks() {
        assert_eq!(
            resolve_path(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
        assert_eq!(resolve_path(Path::new("/a/../../b")), PathBuf::from("/b"));
        let rel = resolve_path(Path::new("x/y"));
        assert!(rel.is_absolute());
        assert!(rel.ends_with("x/y"));
    }

    #[test]
    fn readiness_needs_both_health_and_a_writable_database() {
        let mk = |status: &'static str, writable: bool| DeploymentDiagnostics {
            generated_at: String::new(),
            app: AppDiagnostics {
                name: String::new(),
                version: String::new(),
                node_env: String::new(),
                runtime: "web",
                container_likely: false,
                platform: String::new(),
                arch: "x64",
                node: String::new(),
                uptime_seconds: 0,
            },
            health: HealthDiagnostics {
                status,
                db_ping_ms: Some(0),
                error: None,
            },
            database: DatabaseDiagnostics {
                path: String::new(),
                data_dir: String::new(),
                data_dir_source: "cwd",
                exists: true,
                size_bytes: None,
                writable,
                journal_mode: None,
                error: None,
            },
            network: infer_deployment_network(&HeaderMap::new()),
            security: read_security(),
            checks: vec![],
        };
        assert!(is_ready(&mk("ok", true)));
        assert!(!is_ready(&mk("ok", false)));
        assert!(!is_ready(&mk("degraded", true)));
    }

    #[test]
    fn package_json_is_the_app_not_the_crate() {
        assert_eq!(package_field("name"), "privacytracker");
        assert!(!package_field("version").is_empty());
        assert_ne!(package_field("version"), env!("CARGO_PKG_VERSION"));
    }
}
