//! The desktop launch credential end to end, on a server started the way
//! the Tauri shell starts it: `serve_with` with a host environment that
//! carries `PRIVACYTRACKER_DESKTOP_TOKEN`, over a real socket.
//!
//! A test binary of its own because the host environment and the data
//! directory are fixed once per process (see `embed.rs`).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use privacytracker_core::server::desktop_auth::{
    bootstrap_path, issue_bootstrap_nonce, CREDENTIAL_ENV, CREDENTIAL_HEADER, SESSION_COOKIE,
};
use privacytracker_core::server::{serve_with, ServeConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const CREDENTIAL: &str = "5f1c0d2e3b4a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

struct Reply {
    status: u16,
    head: String,
    body: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }
}

/// One HTTP/1.1 exchange on a fresh connection.
async fn exchange(addr: SocketAddr, request: &str) -> Reply {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read");
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("no status line in {text:?}"));
    Reply {
        status,
        head: head.to_string(),
        body: body.to_string(),
    }
}

fn scratch_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pt-core-desktop-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn a_desktop_server_answers_its_api_only_to_this_launch() {
    let data_dir = scratch_dir().join("data");
    let host: HashMap<String, String> = [
        ("PRIVACYTRACKER_DATA_DIR", data_dir.to_str().unwrap()),
        ("PRIVACYTRACKER_BIND_HOST", "127.0.0.1"),
        ("PRIVACYTRACKER_RUNTIME", "desktop"),
        ("NODE_ENV", "production"),
        (CREDENTIAL_ENV, CREDENTIAL),
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
                ..ServeConfig::default()
            },
        )
        .await
        .expect("serve");
        let addr = server.local_addr();
        let hostport = format!("127.0.0.1:{}", addr.port());
        let origin = format!("http://{hostport}");
        let cookie = format!("{SESSION_COOKIE}={CREDENTIAL}");

        let get = |path: &str, extra: &str| {
            format!("GET {path} HTTP/1.1\r\nHost: {hostport}\r\n{extra}Connection: close\r\n\r\n")
        };
        let post = |path: &str, extra: &str, json: &str| {
            format!(
                "POST {path} HTTP/1.1\r\nHost: {hostport}\r\n{extra}Content-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{json}",
                json.len()
            )
        };

        // Anyone on the machine without the credential: refused, the
        // public reads and the admin-token status included.
        for path in ["/api/health", "/api/apps", "/api/auth/admin-token/status"] {
            let reply = exchange(addr, &get(path, "")).await;
            assert_eq!(reply.status, 401, "{path}: {}", reply.body);
            assert!(reply.body.contains("Desktop credential required"));
        }
        // A forged matching Origin is not a credential.
        let forged = exchange(
            addr,
            &post(
                "/api/settings/desktop",
                &format!("Origin: {origin}\r\n"),
                r#"{"zoom":1.1}"#,
            ),
        )
        .await;
        assert_eq!(forged.status, 401, "{}", forged.body);

        // A same-user tool with the header: reads, and writes with no Origin.
        let header = format!("{CREDENTIAL_HEADER}: {CREDENTIAL}\r\n");
        let read = exchange(addr, &get("/api/apps", &header)).await;
        assert_eq!(read.status, 200, "{}", read.body);
        let write = exchange(
            addr,
            &post("/api/settings/desktop", &header, r#"{"zoom":1.1}"#),
        )
        .await;
        assert_eq!(write.status, 200, "{}", write.body);

        // The frontend still sees no admin token: nothing it shows changes.
        let status = exchange(addr, &get("/api/auth/admin-token/status", &header)).await;
        assert_eq!(status.status, 200);
        assert_eq!(status.body, r#"{"configured":false,"unlocked":false}"#);

        // The window: the one-time link sets the cookie and redirects home.
        let link = bootstrap_path(&issue_bootstrap_nonce().expect("nonce"));
        let signed_in = exchange(addr, &get(&link, "")).await;
        assert_eq!(signed_in.status, 303, "{}", signed_in.body);
        assert_eq!(signed_in.header("location"), Some("/"));
        let set_cookie = signed_in.header("set-cookie").expect("a session cookie");
        assert!(set_cookie.starts_with(&format!("{cookie};")), "{set_cookie}");
        for attribute in ["HttpOnly", "SameSite=Strict", "Path=/api"] {
            assert!(set_cookie.contains(attribute), "{set_cookie} lacks {attribute}");
        }
        assert_eq!(
            exchange(addr, &get(&link, "")).await.status,
            403,
            "the link works once"
        );

        // The webview's requests: the cookie, and the Origin the browser adds.
        let cookie_line = format!("Cookie: {cookie}\r\n");
        let read = exchange(addr, &get("/api/apps", &cookie_line)).await;
        assert_eq!(read.status, 200, "{}", read.body);
        let write = exchange(
            addr,
            &post(
                "/api/settings/desktop",
                &format!("{cookie_line}Origin: {origin}\r\n"),
                r#"{"zoom":1.2}"#,
            ),
        )
        .await;
        assert_eq!(write.status, 200, "{}", write.body);
        // The cookie never stands in for the Origin.
        let no_origin = exchange(
            addr,
            &post("/api/settings/desktop", &cookie_line, r#"{"zoom":1.3}"#),
        )
        .await;
        assert_eq!(no_origin.status, 403, "{}", no_origin.body);

        // A page is not the API: with no site installed it is the plain
        // 404 every server gives, not the credential's 401.
        assert_eq!(exchange(addr, &get("/dashboard", "")).await.status, 404);

        server
            .shutdown(Duration::from_millis(500))
            .await
            .expect("shutdown");
    });

    let _ = std::fs::remove_dir_all(scratch_dir());
}
