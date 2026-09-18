//! Bounded public GET transport for Phase 2's Apple reads. The connector
//! validates the exact DNS answers it uses; redirects never bypass policy.
//! Private-service POST/streaming support belongs to the later writer phases.
use crate::jsstr::{is_js_whitespace, js_length};
use futures_util::TryStreamExt;
use reqwest::{
    dns::{Addrs, Name, Resolve, Resolving},
    header::HeaderMap,
    Client,
};
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, BufReader};
use url::Url;

pub const APPLE_HOSTS: &[&str] = &["apps.apple.com", "itunes.apple.com"];
pub const RELATED_HOSTS: &[&str] = &[
    "apps.apple.com",
    "itunes.apple.com",
    "rss.applemarketingtools.com",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ValidationError {
    pub error: &'static str,
    pub detail: String,
}
fn invalid(error: &'static str, detail: impl Into<String>) -> ValidationError {
    ValidationError {
        error,
        detail: detail.into(),
    }
}
fn bare(host: &str) -> String {
    host.trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase()
}
pub fn is_metadata(host: &str) -> bool {
    let h = bare(host);
    if [
        "metadata.google.internal",
        "metadata",
        "instance-data",
        "instance-data.ec2.internal",
    ]
    .contains(&h.as_str())
    {
        return true;
    }
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(a)) => a.octets()[..2] == [169, 254],
        Ok(IpAddr::V6(a)) => {
            if let Some(v4) = a.to_ipv4_mapped() {
                return is_metadata(&v4.to_string());
            }
            a.to_string().starts_with("fd00:ec2") || a.segments()[0] & 0xffc0 == 0xfe80
        }
        _ => false,
    }
}
pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, _, _] = v.octets();
            matches!(a, 0 | 10 | 127)
                || a >= 224
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 100 && (64..=127).contains(&b))
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return is_private(IpAddr::V4(v4));
            }
            let s = v.segments();
            !(0x2000..=0x3fff).contains(&s[0]) || s[0] == 0x2002 || (s[0] == 0x2001 && s[1] == 0)
        }
    }
}
pub fn validate(raw: &str, allowed: &[&str], max: usize) -> Result<Url, ValidationError> {
    validate_with(raw, allowed, max, false)
}

/// `validateExternalUrl` with `allowPrivateHosts`: loopback and RFC-1918
/// hosts pass (a self-hosted AI endpoint), metadata hosts never do.
pub fn validate_with(
    raw: &str,
    allowed: &[&str],
    max: usize,
    allow_private_hosts: bool,
) -> Result<Url, ValidationError> {
    if raw.trim_matches(is_js_whitespace).is_empty() {
        return Err(invalid("invalid_url", "URL is empty or not a string"));
    }
    if js_length(raw) > max {
        return Err(invalid("too_long", format!("URL exceeds {max} chars")));
    }
    let u = Url::parse(raw).map_err(|_| invalid("invalid_url", "Not a parseable URL"))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(invalid(
            "unsupported_protocol",
            format!("Only http(s) URLs are accepted (got {}:)", u.scheme()),
        ));
    }
    if !u.username().is_empty() || u.password().is_some_and(|s| !s.is_empty()) {
        return Err(invalid("invalid_url", "URL credentials are not supported"));
    }
    let host = u
        .host_str()
        .unwrap_or("")
        .trim_end_matches('.')
        .to_lowercase();
    if host.is_empty() {
        return Err(invalid("invalid_url", "URL has no hostname"));
    }
    if is_metadata(&host) {
        return Err(invalid(
            "private_host",
            format!("Metadata host {host} is always blocked"),
        ));
    }
    if !allow_private_hosts
        && [
            "localhost",
            "localhost.localdomain",
            "ip6-localhost",
            "ip6-loopback",
        ]
        .contains(&host.as_str())
    {
        return Err(invalid(
            "private_host",
            format!("Hostname {host} is blocked"),
        ));
    }
    if !allow_private_hosts && bare(&host).parse::<IpAddr>().is_ok_and(is_private) {
        return Err(invalid(
            "private_host",
            format!("Hostname {host} is a private/loopback IP"),
        ));
    }
    if !allowed.is_empty()
        && !allowed.iter().any(|p| {
            let p = p.to_ascii_lowercase();
            p.strip_prefix("*.").map_or(host == p, |suffix| {
                host == suffix || host.ends_with(&format!(".{suffix}"))
            })
        })
    {
        return Err(invalid(
            "host_not_allowed",
            format!("Hostname {host} is not on the allowlist"),
        ));
    }
    Ok(u)
}
pub fn app_store_url(raw: &str) -> Result<Url, ValidationError> {
    let u = validate(raw, APPLE_HOSTS, 2048)?;
    static ID: OnceLock<regex::Regex> = OnceLock::new();
    if !ID
        .get_or_init(|| regex::Regex::new(r"(?i)/id[0-9]+(?:/|$|\?)").unwrap())
        .is_match(u.path())
    {
        return Err(invalid(
            "invalid_url",
            "App Store URL must contain an /id<digits> segment",
        ));
    }
    Ok(u)
}
pub fn sanitize_policy(raw: &str) -> String {
    validate(raw, &[], 2048)
        .map(String::from)
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub url: String,
    pub allowed_hosts: Vec<String>,
    pub headers: Vec<(String, String)>,
    pub max_bytes: usize,
    pub timeout_ms: u64,
    pub max_redirects: usize,
    /// `maxUrlLength`: the validator's cap, 2048 unless a caller raises it
    /// (the bundle-id lookup allows 16 KiB for its hundred-id query).
    #[serde(default = "default_max_url_length")]
    pub max_url_length: usize,
    /// `redirect: "follow"` (the default) versus `"manual"`, which hands the
    /// 3xx back with its headers.
    #[serde(default = "default_true")]
    pub follow_redirects: bool,
    /// Whether to read the body at all. Save Page Now cancels it and reads
    /// only the headers.
    #[serde(default = "default_true")]
    pub read_body: bool,
    /// `method`, `GET` unless a caller says otherwise. Webhook delivery
    /// posts.
    #[serde(default = "default_method")]
    pub method: String,
    /// `body`, for a method that carries one. Sent on every hop, as Node's
    /// loop sends it, which is why a body and a cross-origin redirect are
    /// refused together below.
    #[serde(default)]
    pub body: Option<String>,
}
fn default_max_url_length() -> usize {
    2048
}
fn default_true() -> bool {
    true
}
fn default_method() -> String {
    "GET".to_string()
}
impl Request {
    pub fn apple(url: String, hosts: &[&str], max_bytes: usize, timeout_ms: u64) -> Self {
        Self {
            url,
            allowed_hosts: hosts.iter().map(|s| s.to_string()).collect(),
            headers: vec![],
            max_bytes,
            timeout_ms,
            max_redirects: 5,
            max_url_length: 2048,
            follow_redirects: true,
            read_body: true,
            method: default_method(),
            body: None,
        }
    }
    /// `safeFetch` of any public http(s) URL with no host allowlist: the
    /// caller's limits, the validator's 2048-character cap unless raised.
    pub fn public(url: String, max_bytes: usize, timeout_ms: u64) -> Self {
        Self::apple(url, &[], max_bytes, timeout_ms)
    }
}
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    /// The final response's headers, names lowercased.
    pub headers: Vec<(String, String)>,
    /// `finalUrl`: the URL of the last hop, as the validator spelled it.
    pub final_url: String,
}
impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    /// `response.headers.get(name)`: the first header of that name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// One raw round trip below the redirect, size-cap and decoding loop — what
/// `fetch` is to Node's `safeFetch`. `PublicHttp` hops through reqwest; the
/// scrape replay hops through recorded replies, so both run the same loop.
pub struct RawReply {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Pin<Box<dyn AsyncBufRead + Send>>,
}
pub type HopFuture<'a> = Pin<Box<dyn Future<Output = Result<RawReply, String>> + Send + 'a>>;
/// What one hop sends besides its URL and headers.
#[derive(Debug, Clone)]
pub struct Outgoing {
    pub method: String,
    pub body: Option<Vec<u8>>,
}
pub trait Hop: Send + Sync {
    fn hop(&self, url: Url, headers: HeaderMap, outgoing: Outgoing) -> HopFuture<'_>;
}
impl Hop for Client {
    fn hop(&self, url: Url, headers: HeaderMap, outgoing: Outgoing) -> HopFuture<'_> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(outgoing.method.as_bytes())
                .map_err(|_| "fetch failed".to_string())?;
            let mut builder = self.request(method, url).headers(headers);
            if let Some(body) = outgoing.body {
                builder = builder.body(body);
            }
            let response = builder
                .send()
                .await
                .map_err(|_| "fetch failed".to_string())?;
            let status = response.status().as_u16();
            let headers = response.headers().clone();
            let stream = response.bytes_stream().map_err(std::io::Error::other);
            Ok(RawReply {
                status,
                headers,
                body: Box::pin(BufReader::new(tokio_util::io::StreamReader::new(stream))),
            })
        })
    }
}
/// `safeFetch` over any hop, without the DNS preflight: the replay's entry.
pub async fn fetch_via(hop: &dyn Hop, request: Request) -> Result<Reply, String> {
    bounded(hop, request, false).await
}
pub type FetchFuture<'a> = Pin<Box<dyn Future<Output = Result<Reply, String>> + Send + 'a>>;
pub trait Fetcher: Send + Sync {
    fn fetch(&self, request: Request) -> FetchFuture<'_>;
    /// An owned handle for a run spawned off the request, when this
    /// fetcher can hand one out.
    fn shared(&self) -> Option<Arc<dyn Fetcher>> {
        None
    }
}

fn allowed_answers(addrs: &[SocketAddr]) -> bool {
    !addrs.is_empty()
        && addrs
            .iter()
            .all(|a| !is_private(a.ip()) && !is_metadata(&a.ip().to_string()))
}
#[derive(Debug)]
struct PublicResolver;
impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addrs: Vec<_> = tokio::net::lookup_host((name.as_str(), 0)).await?.collect();
            if !allowed_answers(&addrs) {
                return Err("Blocked URL: DNS resolved to a disallowed address".into());
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}
fn builder() -> reqwest::ClientBuilder {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .referer(false)
        .connect_timeout(Duration::from_secs(15))
        .dns_resolver(Arc::new(PublicResolver))
        .pool_max_idle_per_host(1)
        .pool_idle_timeout(Duration::from_secs(30))
}
pub struct PublicHttp;
impl Fetcher for PublicHttp {
    fn shared(&self) -> Option<Arc<dyn Fetcher>> {
        Some(Arc::new(PublicHttp))
    }
    fn fetch(&self, request: Request) -> FetchFuture<'_> {
        Box::pin(async move {
            static CLIENT: OnceLock<Client> = OnceLock::new();
            let client = CLIENT.get_or_init(|| builder().build().expect("Rust TLS client"));
            bounded(client as &dyn Hop, request, true).await
        })
    }
}
async fn preflight(u: &Url) -> Result<(), String> {
    let host = u.host_str().unwrap();
    if let Ok(ip) = bare(host).parse::<IpAddr>() {
        if !is_private(ip) {
            return Ok(());
        }
    } else if let Ok(addrs) = tokio::net::lookup_host((host, 0)).await {
        if allowed_answers(&addrs.collect::<Vec<_>>()) {
            return Ok(());
        }
    }
    Err(format!(
        "Blocked URL: host {host} did not resolve to a public address"
    ))
}
async fn bounded(hop: &dyn Hop, request: Request, check_dns: bool) -> Result<Reply, String> {
    tokio::time::timeout(
        Duration::from_millis(request.timeout_ms),
        perform(hop, request, check_dns),
    )
    .await
    .map_err(|_| "The operation was aborted due to timeout".to_string())?
}
async fn perform(hop: &dyn Hop, request: Request, check_dns: bool) -> Result<Reply, String> {
    let hosts: Vec<_> = request.allowed_hosts.iter().map(String::as_str).collect();
    let mut url = validate(&request.url, &hosts, request.max_url_length)
        .map_err(|e| format!("Blocked URL: {} — {}", e.error, e.detail))?;
    let mut headers = HeaderMap::new();
    for (k, v) in request.headers {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(k.as_bytes()).map_err(|_| "fetch failed")?,
            v.parse().map_err(|_| "fetch failed")?,
        );
    }
    headers
        .entry("accept")
        .or_insert(reqwest::header::HeaderValue::from_static("*/*"));
    headers
        .entry("accept-encoding")
        .or_insert(reqwest::header::HeaderValue::from_static(
            "gzip, deflate, br",
        ));
    let outgoing = Outgoing {
        method: request.method.clone(),
        body: request.body.as_ref().map(|b| b.as_bytes().to_vec()),
    };
    let mut redirects = 0;
    loop {
        if check_dns {
            preflight(&url).await?;
        }
        let RawReply {
            status,
            headers: reply_headers,
            body: mut reader,
        } = hop
            .hop(url.clone(), headers.clone(), outgoing.clone())
            .await?;
        if request.follow_redirects && (300..400).contains(&status) {
            if let Some(location) = reply_headers.get("location") {
                let location = location.to_str().map_err(|_| "fetch failed")?;
                redirects += 1;
                if redirects > request.max_redirects {
                    return Err(format!("safeFetch: too many redirects ({redirects})"));
                }
                let candidate = url
                    .join(location)
                    .map_err(|_| format!("safeFetch: invalid redirect target: {location}"))?;
                let next = validate(candidate.as_str(), &hosts, 2048).map_err(|e| {
                    format!("safeFetch: redirect rejected — {}: {}", e.error, e.detail)
                })?;
                if next.origin() != url.origin() {
                    if outgoing.body.is_some() {
                        return Err(
                            "Refusing cross-origin redirect with a request body".to_string()
                        );
                    }
                    for name in ["authorization", "cookie", "proxy-authorization"] {
                        headers.remove(name);
                    }
                }
                url = next;
                continue;
            }
        }
        if !request.read_body {
            return Ok(Reply {
                final_url: url.to_string(),
                status,
                body: Vec::new(),
                headers: reply_headers
                    .iter()
                    .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                    .collect(),
            });
        }
        let declared = reply_headers
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .map(|s| crate::jsnum::js_to_number(&serde_json::Value::String(s.into())));
        if let Some(n) = declared.filter(|n| n.is_finite() && *n > request.max_bytes as f64) {
            return Err(format!(
                "safeFetch: declared content-length {n} exceeds cap {}",
                request.max_bytes
            ));
        }
        let encoding = reply_headers
            .get("content-encoding")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();
        // Preserve Content-Length before decompressing; reqwest's automatic
        // decoder drops it. Cap the decoded stream, including compressed bombs.
        for coding in encoding.split(',').rev().map(str::trim) {
            use async_compression::tokio::bufread::{
                BrotliDecoder, DeflateDecoder, GzipDecoder, ZlibDecoder,
            };
            reader = match coding {
                "gzip" | "x-gzip" => {
                    let mut d = GzipDecoder::new(reader);
                    d.multiple_members(true);
                    Box::pin(BufReader::new(d))
                }
                "br" => Box::pin(BufReader::new(BrotliDecoder::new(reader))),
                "deflate" => {
                    let zlib = reader
                        .as_mut()
                        .fill_buf()
                        .await
                        .map_err(|_| "terminated")?
                        .first()
                        .is_some_and(|b| b & 15 == 8);
                    if zlib {
                        Box::pin(BufReader::new(ZlibDecoder::new(reader)))
                    } else {
                        Box::pin(BufReader::new(DeflateDecoder::new(reader)))
                    }
                }
                _ => reader,
            };
        }
        let mut body = Vec::new();
        reader
            .take(request.max_bytes as u64 + 1)
            .read_to_end(&mut body)
            .await
            .map_err(|_| "terminated")?;
        if body.len() > request.max_bytes {
            return Err(format!(
                "safeFetch: response exceeded {} bytes",
                request.max_bytes
            ));
        }
        return Ok(Reply {
            final_url: url.to_string(),
            status,
            body,
            headers: reply_headers
                .iter()
                .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                .collect(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        extract::State,
        http::{Request as Incoming, Response},
        Router,
    };
    use serde_json::{json, Value};
    use std::sync::Mutex;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/outbound-cases.json")).unwrap()
    }
    #[test]
    fn node_url_and_address_policy() {
        let f = fixture();
        let mut errors = Vec::new();
        for case in f["validation"].as_array().unwrap() {
            let raw = case["raw"].as_str().unwrap();
            let result = match case["kind"].as_str().unwrap() {
                "policy" => json!(sanitize_policy(raw)),
                kind => match if kind == "apple" {
                    app_store_url(raw)
                } else {
                    validate(raw, APPLE_HOSTS, 2048)
                } {
                    Ok(u) => json!({"ok":true,"url":u.as_str()}),
                    Err(e) => json!({"ok":false,"error":e.error,"detail":e.detail}),
                },
            };
            if result != case["expected"] {
                errors.push(format!(
                    "{raw:?} {} expected={} actual={result}",
                    case["kind"], case["expected"]
                ));
            }
        }
        for case in f["addresses"].as_array().unwrap() {
            let ip = case["ip"].as_str().unwrap();
            assert_eq!(
                json!(is_private(ip.parse().unwrap())),
                case["private"],
                "{ip}"
            );
            assert_eq!(json!(is_metadata(ip)), case["metadata"], "{ip}");
        }
        // Every socket answer must pass, even if the first address is public.
        assert!(!allowed_answers(&[]));
        assert!(allowed_answers(&["8.8.8.8:0".parse().unwrap()]));
        assert!(!allowed_answers(&[
            "8.8.8.8:0".parse().unwrap(),
            "127.0.0.1:0".parse().unwrap()
        ]));
        assert!(errors.is_empty(), "{}", errors.join("\n"));
    }
    #[derive(Clone)]
    struct Server {
        case: Value,
        cursor: Arc<Mutex<usize>>,
        calls: Arc<Mutex<Vec<Value>>>,
    }
    async fn serve(State(s): State<Server>, r: Incoming<Body>) -> Response<Body> {
        let (parts, _) = r.into_parts();
        let h = |key| {
            parts
                .headers
                .get(key)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        s.calls.lock().unwrap().push(json!({"host":h("host"),"path":parts.uri.to_string(),"authorization":h("authorization"),"cookie":h("cookie")}));
        let step = {
            let mut n = s.cursor.lock().unwrap();
            let steps = s.case["steps"].as_array().unwrap();
            let v = steps[(*n).min(steps.len() - 1)].clone();
            *n += 1;
            v
        };
        if let Some(ms) = step["delay_headers_ms"].as_u64() {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        let mut response = Response::builder().status(step["status"].as_u64().unwrap() as u16);
        for (k, v) in step["headers"].as_object().unwrap() {
            response = response.header(k, v.as_str().unwrap());
        }
        let body: Vec<u8> = serde_json::from_value(step["body"].clone()).unwrap();
        let delay = step["delay_body_ms"].as_u64().unwrap_or(0);
        let stream = futures_util::stream::once(async move {
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            Ok::<_, std::io::Error>(body)
        });
        response.body(Body::from_stream(stream)).unwrap()
    }
    #[tokio::test]
    async fn node_real_http_redirects_streaming_and_decompression() {
        let f = fixture();
        let mut errors = Vec::new();
        for case in f["transport"].as_array().unwrap() {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let state = Server {
                case: case.clone(),
                cursor: Arc::new(Mutex::new(0)),
                calls: Arc::new(Mutex::new(vec![])),
            };
            let router = Router::new().fallback(serve).with_state(state.clone());
            let handle = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
            // This DNS substitution exists only in a compiled unit test.
            // URL/redirect policy and the real HTTP/decoder path still run.
            let client = builder()
                .resolve("apps.apple.com", addr)
                .resolve("itunes.apple.com", addr)
                .build()
                .unwrap();
            let request: Request = serde_json::from_value(case["request"].clone()).unwrap();
            let actual = match bounded(&client, request, false).await {
                Ok(r) => json!({"status":r.status,"body":r.body}),
                Err(e) => json!({"error":e}),
            };
            let calls = json!(*state.calls.lock().unwrap());
            if actual != case["expected"] || calls != case["calls"] {
                errors.push(format!(
                    "{} expected={} actual={actual}\nexpected calls={} actual calls={calls}",
                    case["name"], case["expected"], case["calls"]
                ));
            }
            handle.abort();
            let _ = handle.await;
        }
        assert!(errors.is_empty(), "{}", errors.join("\n\n"));
    }
    #[tokio::test]
    async fn production_connector_rejects_loopback_dns_answers() {
        let result = PublicResolver.resolve("localhost".parse().unwrap()).await;
        assert!(result.is_err());
        assert!(preflight(&Url::parse("http://127.0.0.1/").unwrap())
            .await
            .is_err());
    }
}
