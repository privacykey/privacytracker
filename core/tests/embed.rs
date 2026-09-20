//! The embedding entry point end to end, as the Tauri shell will call it.
//!
//! A test binary of its own because the host environment and the data
//! directory are fixed once per process: sharing a process with the unit
//! tests would fix them for every test that follows.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use privacytracker_core::server::{serve_with, ServeConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// One HTTP/1.1 exchange on a fresh connection: the status and the body.
async fn exchange(addr: SocketAddr, request: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read");
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("no status line in {text:?}"));
    let body = text
        .split_once("\r\n\r\n")
        .map_or("", |(_, b)| b)
        .to_string();
    (status, body)
}

fn scratch_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pt-core-embed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn an_embedded_server_runs_on_its_host_environment_and_stops_within_the_grace() {
    // The PROCESS environment asks for a token on every request. The host
    // environment below is loopback with no token, as the Tauri shell's
    // sidecar environment was; a server that read the process environment
    // would refuse the unauthenticated requests below with a 401.
    std::env::set_var("AUDITOR_ADMIN_TOKEN", "from-the-process-environment");
    std::env::set_var("PRIVACYTRACKER_NETWORK_EXPOSED", "1");
    // And a decoy data directory: a server that read the process
    // environment would open its database there, never in the repo.
    let decoy = scratch_dir().join("decoy");
    std::env::set_var("PRIVACYTRACKER_DATA_DIR", &decoy);

    let data_dir = scratch_dir().join("data");
    let host: HashMap<String, String> = [
        ("PRIVACYTRACKER_DATA_DIR", data_dir.to_str().unwrap()),
        ("PRIVACYTRACKER_BIND_HOST", "127.0.0.1"),
        ("PRIVACYTRACKER_RUNTIME", "desktop"),
        ("NODE_ENV", "production"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let server = serve_with(
            listener,
            ServeConfig {
                env: Some(host.clone()),
                ..ServeConfig::default()
            },
        )
        .await
        .expect("serve");
        let addr = server.local_addr();
        let hostport = format!("127.0.0.1:{}", addr.port());

        // A read.
        let (status, body) = exchange(
            addr,
            &format!("GET /api/health HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\n\r\n"),
        )
        .await;
        assert_eq!(status, 200, "health: {body}");

        // A same-origin mutation with no token: allowed on a loopback server.
        let json = r#"{"zoom":1.1}"#;
        let (status, body) = exchange(
            addr,
            &format!(
                "POST /api/settings/desktop HTTP/1.1\r\nHost: {hostport}\r\nOrigin: http://{hostport}\r\n\
                 Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                json.len()
            ),
        )
        .await;
        assert_eq!(status, 200, "desktop settings: {body}");

        // The database is where the host said, private, and the boot writes
        // saw the desktop runtime.
        let db_path = data_dir.join("privacy.db");
        assert!(db_path.exists(), "privacy.db in the host's data directory");
        assert!(!decoy.exists(), "nothing opened where the process pointed");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&data_dir), 0o700, "data directory");
            assert_eq!(mode(&db_path), 0o600, "database file");
        }
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        let runtime: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'runtime_environment'",
                [],
                |r| r.get(0),
            )
            .expect("runtime_environment was written at boot");
        assert_eq!(runtime, "desktop");

        // The feature-flag migration ran first, on the fresh database: its
        // marker, and six steps' rows plus the closing one.
        let version: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'feature_flag_migration_version'",
                [],
                |r| r.get(0),
            )
            .expect("the migration wrote its marker at boot");
        assert_eq!(version, "2");
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM activity_log WHERE type = 'migration' AND status = 'ok'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 13, "migration activity rows");
        drop(conn);

        // One server per process: a different environment is refused.
        let mut other = host.clone();
        other.insert("PRIVACYTRACKER_RUNTIME".into(), "docker".into());
        let second = serve_with(
            TcpListener::bind("127.0.0.1:0").await.unwrap(),
            ServeConfig {
                env: Some(other),
                ..ServeConfig::default()
            },
        )
        .await;
        assert!(second.is_err(), "a second, different environment is refused");

        // A request in flight that never finishes: a handler reading a body
        // that stops arriving. The shutdown waits for it through the grace
        // and no longer.
        let mut stuck = TcpStream::connect(addr).await.unwrap();
        stuck
            .write_all(
                format!(
                    "POST /api/settings/desktop HTTP/1.1\r\nHost: {hostport}\r\nOrigin: http://{hostport}\r\n\
                     Content-Type: application/json\r\nContent-Length: 64\r\n\r\n{{\"zoom\""
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        // Let the request reach its handler before stopping.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let grace = Duration::from_millis(600);
        let started = Instant::now();
        server.shutdown(grace).await.expect("shutdown");
        let took = started.elapsed();
        assert!(
            took >= grace - Duration::from_millis(50),
            "the request in flight was given the grace, took {took:?}"
        );
        assert!(took < Duration::from_secs(3), "shutdown took {took:?}");

        // The listener is closed on return.
        assert!(
            TcpStream::connect(addr).await.is_err(),
            "nothing accepts on the port after shutdown"
        );
        drop(stuck);
    });

    let _ = std::fs::remove_dir_all(scratch_dir());
}
