//! Serving a network, as `pt-core serve --host 0.0.0.0` does in Docker,
//! over a loopback listener.
//!
//! A test binary of its own because the host environment and the data
//! directory are fixed once per process, and because it installs the one
//! logger a process may have.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use privacytracker_core::server::{serve_with, ServeConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Every warning the server logs, as an operator would read them.
struct Recorder(Mutex<Vec<String>>);

impl log::Log for Recorder {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Warn
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            self.0.lock().unwrap().push(record.args().to_string());
        }
    }

    fn flush(&self) {}
}

static RECORDER: Recorder = Recorder(Mutex::new(Vec::new()));

/// Short, so the test waits a fraction of a second where Docker waits
/// Node's 60.
const TIMEOUT: Duration = Duration::from_millis(300);

/// The smallest build the core will serve (the home page and the not-found
/// page it insists on), and deliberately no `csp-hashes.json`.
fn write_site_without_csp_hashes(root: &std::path::Path) {
    let app = root.join(".next").join("server").join("app");
    std::fs::create_dir_all(&app).expect("site dirs");
    for (stem, meta) in [
        ("index", r#"{"headers":{"x-nextjs-prerender":"1"}}"#),
        (
            "_not-found",
            r#"{"status":404,"headers":{"x-nextjs-prerender":"1"}}"#,
        ),
    ] {
        std::fs::write(app.join(format!("{stem}.html")), "<html></html>").expect("page");
        std::fs::write(app.join(format!("{stem}.meta")), meta).expect("page metadata");
        std::fs::write(app.join(format!("{stem}.rsc")), "RSC").expect("page payload");
    }
}

/// Send `request` on a fresh connection and read until the server closes
/// it. Returns what was read and how long the close took.
async fn until_closed(addr: SocketAddr, request: &[u8]) -> (String, Duration) {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream.write_all(request).await.expect("write");
    let started = Instant::now();
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut raw))
        .await
        .expect("the server should close the connection, not leave it open")
        .expect("read");
    (
        String::from_utf8_lossy(&raw).into_owned(),
        started.elapsed(),
    )
}

#[test]
fn a_network_facing_server_warns_without_a_token_and_times_out_slow_headers() {
    log::set_logger(&RECORDER).expect("the only logger in this process");
    log::set_max_level(log::LevelFilter::Warn);

    let root = std::env::temp_dir().join(format!("pt-core-network-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (data_dir, site) = (root.join("data"), root.join("site"));
    write_site_without_csp_hashes(&site);
    // What the Docker image declares, with the admin token forgotten.
    let host: HashMap<String, String> = [
        ("PRIVACYTRACKER_DATA_DIR", data_dir.to_str().unwrap()),
        ("PRIVACYTRACKER_BIND_HOST", "0.0.0.0"),
        ("PRIVACYTRACKER_NETWORK_EXPOSED", "1"),
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
                env: Some(host),
                site: Some(site),
                header_read_timeout: Some(TIMEOUT),
            },
        )
        .await
        .expect("serve");
        let addr = server.local_addr();

        // The warning instrumentation.ts prints, and the line proxy.ts logs
        // for a build without its CSP hashes: each once, at boot.
        let logged = |prefix: &str| {
            RECORDER
                .0
                .lock()
                .unwrap()
                .iter()
                .filter(|line| line.starts_with(prefix))
                .count()
        };
        assert_eq!(
            logged("[security] This instance is declared network-exposed but no AUDITOR_ADMIN_TOKEN is set"),
            1,
            "the posture warning, exactly once"
        );
        assert_eq!(
            logged("[proxy] csp-hashes.json not found"),
            1,
            "the missing CSP hashes, exactly once"
        );

        // It warns rather than refuses: public reads answer and private ones
        // fail closed on their own.
        let (health, _) = until_closed(
            addr,
            b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(health.starts_with("HTTP/1.1 200"), "health: {health}");
        let (apps, _) = until_closed(
            addr,
            b"GET /api/apps HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(apps.starts_with("HTTP/1.1 401"), "apps without a token: {apps}");

        // A client that never finishes its headers is cut off after the
        // timeout, where it used to be able to hold the connection forever.
        let (_, took) = until_closed(
            addr,
            b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n",
        )
        .await;
        assert!(
            took >= TIMEOUT - Duration::from_millis(50) && took < Duration::from_secs(3),
            "slow headers closed after the timeout, took {took:?}"
        );

        // The same timeout closes a keep-alive connection left idle after
        // its response.
        let (idle, took) = until_closed(
            addr,
            b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        )
        .await;
        assert!(idle.starts_with("HTTP/1.1 200"), "idle: {idle}");
        assert!(
            took >= TIMEOUT - Duration::from_millis(50) && took < Duration::from_secs(3),
            "an idle keep-alive connection closed after the timeout, took {took:?}"
        );

        server
            .shutdown(Duration::from_secs(3))
            .await
            .expect("stops");
    });
    let _ = std::fs::remove_dir_all(&root);
}
