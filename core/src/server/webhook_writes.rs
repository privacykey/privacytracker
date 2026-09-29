//! Phase 4, batch 6: notification webhook delivery (lib/notification-
//! webhooks.ts), which until now the core only read the settings of. The
//! user pastes a Slack, Discord, Teams or generic JSON endpoint and picks a
//! frequency, and notifications are POSTed there at once or as a daily or
//! weekly batch. Three call sites, as in Node:
//!
//!   * `fireWebhookIfConfigured` fires `postImmediateWebhook` when a row
//!     lands and the frequency is `immediate`: from `createNotification`
//!     (`POST /api/dev/seed-notification`, a policy-text change in the
//!     policy store) and from an App Store scrape, which inserts its
//!     label-change notification inside its own commit and fires once that
//!     commit has landed (`scrape::fetch::fire_change_webhook`).
//!   * The 30-minute tick fires `maybePostSummaryWebhook`, which
//!     self-limits through `notification_webhook_last_sent`.
//!   * `POST /api/notifications/webhook-test` fires a sample payload at a
//!     URL the wizard has not saved yet.
//!
//! Every POST goes through the same transport as every other fetch, so a
//! webhook can no more reach a private address than a scrape can. It is a
//! POST with `redirect: manual`: the body is delivered once and never
//! replayed to a redirect target. Gated by
//! `core/tests/fixtures/leftovers-cases.json`.
use super::{
    body::{body_error_response, BodyOutcome},
    guard::Actor,
    json::{json_error, json_ok},
    maintenance_writes,
    preview::string as js_string,
    settings::get_setting_with,
    stats,
    writes::{Cx, RouteSpec, WriteRequest},
};
use crate::{
    jsnum::js_to_number,
    jsstr::{js_length, js_slice_prefix, js_trim},
    outbound::{Fetcher, Request},
    scrape::persist::{DbAccess, Ids, RandomIds, Writer},
};
use axum::{
    body::Body,
    http::{Method, StatusCode},
    response::Response,
};
use serde_json::{json, Map, Value};

const FORMATS: [&str; 4] = ["slack", "discord", "teams", "generic"];
const FREQUENCIES: [&str; 4] = ["immediate", "daily_summary", "weekly_summary", "off"];
const LAST_SENT: &str = "notification_webhook_last_sent";
const RECENT: &str = "SELECT app_name, change_summary, created_at\n       FROM notifications\n       WHERE created_at >= ?\n       ORDER BY created_at DESC\n       LIMIT 50";
const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

pub(super) fn handles(spec: &RouteSpec) -> bool {
    matches!(
        spec.path,
        "/api/notifications/webhook-test" | "/api/dev/seed-notification"
    )
}

/// One notification row condensed to what a payload needs.
#[derive(Debug, Clone)]
pub(super) struct Notification {
    pub app_name: Option<String>,
    pub summary: String,
    pub created_at: Value,
}

/// What a caller hands the fan-out: `fireWebhookIfConfigured`'s two
/// arguments, reduced to the headline it makes of them.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Immediate {
    pub app_name: String,
    pub headline: String,
}

struct Config {
    url: String,
    format: &'static str,
    frequency: &'static str,
}

/// `readWebhookConfig`: `None` when the URL is blank or the frequency is
/// `off`, so a caller short-circuits rather than posting to nothing.
fn read_config(conn: &rusqlite::Connection) -> Option<Config> {
    let setting = |key: &str, default: &str| {
        get_setting_with(conn, key, default).unwrap_or_else(|_| default.to_string())
    };
    let url = js_trim(&setting("notification_webhook_url", "")).to_string();
    if url.is_empty() {
        return None;
    }
    let format_raw = setting("notification_webhook_format", "generic");
    let frequency_raw = setting("notification_webhook_frequency", "immediate");
    let format = FORMATS
        .iter()
        .copied()
        .find(|f| *f == format_raw)
        .unwrap_or("generic");
    let frequency = FREQUENCIES
        .iter()
        .copied()
        .find(|f| *f == frequency_raw)
        .unwrap_or("immediate");
    if frequency == "off" {
        return None;
    }
    Some(Config {
        url,
        format,
        frequency,
    })
}

/// `escapeSlackText`: Slack's three control characters, as its
/// formatting guide escapes them.
pub(super) fn escape_slack_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// `escapeMarkdownText`: each character of `MARKDOWN_SPECIAL`
/// (`` \ ` * _ ~ | < > [ ] ( ) # & - ``) backslash-escaped, which Discord
/// and Teams both render as the plain character.
pub(super) fn escape_markdown_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(
            c,
            '\\' | '`'
                | '*'
                | '_'
                | '~'
                | '|'
                | '<'
                | '>'
                | '['
                | ']'
                | '('
                | ')'
                | '#'
                | '&'
                | '-'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `escapeDiscordText`: Markdown escaped, and `@everyone` / `@here`
/// broken with a zero-width space so they read as text.
pub(super) fn escape_discord_text(text: &str) -> String {
    escape_markdown_text(text)
        .replace("@everyone", "@\u{200b}everyone")
        .replace("@here", "@\u{200b}here")
}

/// `buildPayload`: Slack and Discord take a line of text, Teams a
/// MessageCard, generic the text and the rows both. Every chat format
/// escapes its own markup, because titles and lines carry App Store app
/// names the developer chooses; Discord also turns every mention off.
fn build_payload(
    format: &str,
    title: &str,
    lines: &[String],
    notifications: &[Notification],
) -> Value {
    let text = format!("{title}\n{}", lines.join("\n"));
    match format {
        "slack" => json!({ "text": escape_slack_text(&text) }),
        "discord" => {
            // Discord caps `content` at 2000 characters; cut well short,
            // after escaping so the escapes cannot push it over.
            let escaped = escape_discord_text(&text);
            let content = if js_length(&escaped) > 1900 {
                format!("{}…", js_slice_prefix(&escaped, 1900))
            } else {
                escaped
            };
            json!({ "content": content, "allowed_mentions": { "parse": [] } })
        }
        "teams" => {
            let mut card = Map::new();
            card.insert("@type".into(), json!("MessageCard"));
            card.insert("@context".into(), json!("https://schema.org/extensions"));
            card.insert("summary".into(), json!(escape_markdown_text(title)));
            card.insert("themeColor".into(), json!("0a84ff"));
            card.insert("title".into(), json!(escape_markdown_text(title)));
            card.insert(
                "text".into(),
                json!(escape_markdown_text(&lines.join("\n\n"))),
            );
            Value::Object(card)
        }
        _ => json!({
            "title": title,
            "text": text,
            "notifications": notifications.iter().map(|n| json!({
                "appName": n.app_name,
                "summary": n.summary,
                "createdAt": n.created_at,
            })).collect::<Vec<_>>(),
        }),
    }
}

/// What `postWebhook` answers: the response's `ok` and status, and `HTTP
/// <status>` as the detail of a response that was not ok.
struct Posted {
    ok: bool,
    status: u16,
    detail: Option<String>,
}

/// `postWebhook`: a POST through the transport, redirects not followed,
/// the response bounded at 64 KiB, the URL at 512 characters, ten
/// seconds. A refused URL or a failed request is the error.
async fn post_webhook(
    fetcher: &dyn Fetcher,
    cfg: &Config,
    title: &str,
    lines: &[String],
    notifications: &[Notification],
) -> Result<Posted, String> {
    let body = build_payload(cfg.format, title, lines, notifications).to_string();
    let mut request = Request::public(cfg.url.clone(), 64 * 1024, 10_000);
    request.max_url_length = 512;
    request.follow_redirects = false;
    request.method = "POST".to_string();
    request.body = Some(body);
    request.headers = vec![("Content-Type".to_string(), "application/json".to_string())];
    let reply = fetcher.fetch(request).await?;
    let ok = reply.ok();
    Ok(Posted {
        ok,
        status: reply.status,
        detail: (!ok).then(|| format!("HTTP {}", reply.status)),
    })
}

/// `postImmediateWebhook`'s POST, once `readWebhookConfig` has said
/// `immediate`: a failure is logged, never raised — the row is already
/// written and a broken webhook must not unwrite it.
async fn post_immediate(fetcher: &dyn Fetcher, cfg: Config, n: Notification) {
    let title = match &n.app_name {
        Some(app) => format!("📱 {app}: {}", n.summary),
        None => format!("📱 {}", n.summary),
    };
    let lines = vec![n.summary.clone()];
    if let Err(e) = post_webhook(fetcher, &cfg, &title, &lines, &[n]).await {
        super::diag::log_warn(format!("[webhook] immediate POST failed: {e}"));
    }
}

/// `fireWebhookIfConfigured`. The config is read where the fan-out is
/// called, as `postImmediateWebhook` reads it before its first await, and
/// nothing is posted unless it says `immediate`. The POST itself is
/// detached from the caller on the server, where a slow webhook must not
/// hold a request or a sync, whatever accessor the caller has; it is made
/// inline in the replay, whose fetcher cannot be shared and whose canned
/// hop answers at once.
pub(crate) async fn fire_immediate(
    db: &mut dyn DbAccess,
    fetcher: &dyn Fetcher,
    now: i64,
    immediate: Immediate,
) {
    let Some(cfg) = db.with(|w| read_config(w.conn)) else {
        return;
    };
    if cfg.frequency != "immediate" {
        return;
    }
    let notification = Notification {
        app_name: Some(immediate.app_name),
        summary: immediate.headline,
        created_at: json!(now),
    };
    match fetcher.shared() {
        Some(fetcher) => {
            tokio::spawn(async move {
                post_immediate(fetcher.as_ref(), cfg, notification).await;
            });
        }
        None => post_immediate(fetcher, cfg, notification).await,
    }
}

/// `maybePostSummaryWebhook`: from the 30-minute tick. A day or a week
/// after the last summary, the notifications since it — the fifty newest —
/// go out as one post and the cursor moves. Nothing to report moves the
/// cursor too, so an empty window is not re-read every tick; a failed
/// request leaves it, so the next tick retries the same window. Returns
/// how many notifications went out.
pub(super) async fn maybe_post_summary(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    now: i64,
) -> usize {
    struct Window {
        cfg: Config,
        rows: Vec<Notification>,
    }
    let window = db.with(|w| -> Result<Option<Window>, String> {
        let Some(cfg) = read_config(w.conn) else {
            return Ok(None);
        };
        if cfg.frequency != "daily_summary" && cfg.frequency != "weekly_summary" {
            return Ok(None);
        }
        let interval_ms = if cfg.frequency == "daily_summary" {
            DAY_MS
        } else {
            7.0 * DAY_MS
        };
        // `Number(getSetting(…, "0")) || 0`.
        let last_sent = get_setting_with(w.conn, LAST_SENT, "0")
            .map(|s| js_to_number(&Value::String(s)))
            .unwrap_or(0.0);
        let last_sent = if last_sent.is_nan() { 0.0 } else { last_sent };
        if (now as f64) - last_sent < interval_ms {
            return Ok(None);
        }
        let since = if last_sent > 0.0 {
            last_sent
        } else {
            now as f64 - interval_ms
        };
        let rows = stats::query(w.conn, RECENT, &[rusqlite::types::Value::Real(since)])
            .map_err(|e| e.to_string())?;
        if rows.is_empty() {
            let mut cx = Cx { w, ids, now };
            cx.set(LAST_SENT, &now.to_string())?;
            return Ok(None);
        }
        Ok(Some(Window {
            cfg,
            rows: rows
                .into_iter()
                .map(|r| Notification {
                    app_name: r["app_name"].as_str().map(str::to_string),
                    summary: js_string(&r["change_summary"]),
                    created_at: r["created_at"].clone(),
                })
                .collect(),
        }))
    });
    let window = match window {
        Ok(Some(window)) => window,
        Ok(None) => return 0,
        Err(e) => {
            super::diag::log_warn(format!("[webhook] summary tick failed: {e}"));
            return 0;
        }
    };
    let count = window.rows.len();
    let plural = if count == 1 { "" } else { "s" };
    let title = if window.cfg.frequency == "daily_summary" {
        format!("🌙 Daily privacytracker summary — {count} update{plural}")
    } else {
        format!("📅 Weekly privacytracker summary — {count} update{plural}")
    };
    let lines: Vec<String> = window
        .rows
        .iter()
        .map(|r| match r.app_name.as_deref().filter(|a| !a.is_empty()) {
            Some(app) => format!("• {app}: {}", r.summary),
            None => format!("• {}", r.summary),
        })
        .collect();
    match post_webhook(fetcher, &window.cfg, &title, &lines, &window.rows).await {
        Ok(_) => {
            let stamped = db.with(|w| {
                let mut cx = Cx { w, ids, now };
                cx.set(LAST_SENT, &now.to_string())
            });
            if let Err(e) = stamped {
                super::diag::log_warn(format!("[webhook] summary cursor failed: {e}"));
            }
            count
        }
        Err(e) => {
            super::diag::log_warn(format!("[webhook] summary POST failed: {e}"));
            0
        }
    }
}

/// The 45 s, then 30-minute, webhook summary tick.
pub(crate) async fn tick_webhook_summary(db: &mut dyn DbAccess, fetcher: &dyn Fetcher, now: i64) {
    let mut ids = RandomIds;
    let count = maybe_post_summary(db, &mut ids, fetcher, now).await;
    if count > 0 {
        // `console.log`, which has no ring entry.
        log::info!("[Webhook] Posted summary with {count} notifications");
    }
}

/// `postWebhookTestPayload`: the wizard's Test button, against a URL not
/// yet saved. Every failure is an answer, never an error.
async fn post_test_payload(fetcher: &dyn Fetcher, url: String, format: &'static str) -> Value {
    let cfg = Config {
        url,
        format,
        frequency: "immediate",
    };
    let lines = vec![
        "This is a test message — your webhook is wired up correctly.".to_string(),
        "You'll start seeing notification summaries here per your chosen frequency.".to_string(),
    ];
    match post_webhook(
        fetcher,
        &cfg,
        "✅ Webhook test from privacytracker",
        &lines,
        &[],
    )
    .await
    {
        Ok(posted) => {
            let mut out = Map::new();
            out.insert("ok".into(), json!(posted.ok));
            out.insert("status".into(), json!(posted.status));
            if let Some(detail) = posted.detail {
                out.insert("detail".into(), json!(detail));
            }
            Value::Object(out)
        }
        Err(e) => json!({ "ok": false, "status": 0, "detail": e }),
    }
}

/// A 500 with no body, which is what Next answers when a handler throws.
fn thrown() -> Response {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .body(Body::empty())
        .unwrap()
}

/// `POST /api/notifications/webhook-test`.
async fn webhook_test(fetcher: &dyn Fetcher, body: BodyOutcome) -> Response {
    if let Some(refused) = body_error_response(&body) {
        return refused;
    }
    let body = match body {
        BodyOutcome::Json(v) => v,
        _ => return json_error(StatusCode::BAD_REQUEST, "Invalid JSON"),
    };
    // `body.url` on a null body throws; on any other non-object it is
    // undefined.
    if body.is_null() {
        return thrown();
    }
    let field = |key: &str, default: &str| {
        body.as_object()
            .and_then(|o| o.get(key))
            .filter(|v| !v.is_null())
            .map_or(default.to_string(), js_string)
    };
    let url = js_trim(&field("url", "")).to_string();
    if url.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "url is required");
    }
    let format = field("format", "generic");
    let Some(format) = FORMATS.iter().copied().find(|f| *f == format) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            &format!("format must be one of: {}", FORMATS.join(", ")),
        );
    };
    json_ok(&post_test_payload(fetcher, url, format).await)
}

pub(super) async fn perform(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    now: i64,
    fetcher: &dyn Fetcher,
    req: WriteRequest<'_>,
    actor: &Actor,
) -> Response {
    match (req.spec.path, &req.spec.method) {
        ("/api/notifications/webhook-test", &Method::POST) => webhook_test(fetcher, req.body).await,
        ("/api/dev/seed-notification", &Method::POST) => {
            let body = req.body;
            let (response, immediate) = db.with(|w: &mut Writer<'_>| {
                let mut cx = Cx { w, ids, now };
                maintenance_writes::seed_notification(&mut cx, body, actor)
            });
            if let Some(immediate) = immediate {
                fire_immediate(db, fetcher, now, immediate).await;
            }
            response
        }
        _ => json_error(StatusCode::NOT_FOUND, "Not Found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{outbound::FetchFuture, scrape::persist::Locked};
    use futures_util::FutureExt;
    use std::sync::{Arc, Mutex};

    /// A request as sent: its method, URL and body.
    type Sent = (String, String, Option<String>);

    /// A shareable transport, as the server's is, whose every request
    /// hangs: it records what it was asked to send and never answers.
    #[derive(Clone, Default)]
    struct Hanging {
        seen: Arc<Mutex<Vec<Sent>>>,
    }

    impl Fetcher for Hanging {
        fn shared(&self) -> Option<Arc<dyn Fetcher>> {
            Some(Arc::new(self.clone()))
        }
        fn fetch(&self, request: Request) -> FetchFuture<'_> {
            self.seen
                .lock()
                .unwrap()
                .push((request.method, request.url, request.body));
            Box::pin(std::future::pending())
        }
    }

    #[test]
    fn an_immediate_post_never_holds_the_caller() {
        // The background ticks (the scheduled sync, its resume, the import
        // queue) reach a scrape through `Locked`, which cannot be detached.
        // The POST must leave the caller all the same, with the config read
        // where the fan-out was called.
        let conn = crate::db::open_and_migrate(std::path::Path::new(":memory:")).unwrap();
        for (key, value) in [
            ("notification_webhook_url", "https://hooks.example.com/pt"),
            ("notification_webhook_format", "slack"),
            ("notification_webhook_frequency", "immediate"),
        ] {
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
                [key, value],
            )
            .unwrap();
        }
        let conn = std::sync::Mutex::new(conn);
        let mut db = Locked {
            conn: &conn,
            log: None,
            on_wait: None,
        };
        let fetcher = Hanging::default();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let immediate = Immediate {
                app_name: "App".to_string(),
                headline: "Added".to_string(),
            };
            let fired = fire_immediate(&mut db, &fetcher, 5, immediate).now_or_never();
            assert!(fired.is_some(), "the caller waited on the webhook");
            for _ in 0..3 {
                tokio::task::yield_now().await;
            }
        });
        assert_eq!(
            *fetcher.seen.lock().unwrap(),
            vec![(
                "POST".to_string(),
                "https://hooks.example.com/pt".to_string(),
                Some(r#"{"text":"📱 App: Added\nAdded"}"#.to_string()),
            )]
        );
    }

    fn n(app: Option<&str>, summary: &str) -> Notification {
        Notification {
            app_name: app.map(str::to_string),
            summary: summary.to_string(),
            created_at: json!(5),
        }
    }

    #[test]
    fn payloads_take_each_platform_shape() {
        let lines = vec!["one".to_string(), "two".to_string()];
        let rows = [n(Some("App"), "one"), n(None, "two")];
        assert_eq!(
            build_payload("slack", "T", &lines, &rows).to_string(),
            r#"{"text":"T\none\ntwo"}"#
        );
        assert_eq!(
            build_payload("teams", "T", &lines, &rows).to_string(),
            r#"{"@type":"MessageCard","@context":"https://schema.org/extensions","summary":"T","themeColor":"0a84ff","title":"T","text":"one\n\ntwo"}"#
        );
        assert_eq!(
            build_payload("generic", "T", &lines, &rows).to_string(),
            r#"{"title":"T","text":"T\none\ntwo","notifications":[{"appName":"App","summary":"one","createdAt":5},{"appName":null,"summary":"two","createdAt":5}]}"#
        );
    }

    #[test]
    fn hostile_app_names_carry_no_markup_into_chat_payloads() {
        let name = "Evil <!channel> @everyone @here [Update now](https://x.test) *b* & <@123>";
        let title = format!("📱 {name}: 2 privacy changes");
        let lines = vec!["2 privacy changes".to_string()];
        let rows = [n(Some(name), "2 privacy changes")];
        assert_eq!(
            build_payload("slack", &title, &lines, &rows)["text"],
            "📱 Evil &lt;!channel&gt; @everyone @here [Update now](https://x.test) *b* &amp; &lt;@123&gt;: 2 privacy changes\n2 privacy changes"
        );
        let discord = build_payload("discord", &title, &lines, &rows);
        assert_eq!(
            discord["content"],
            "📱 Evil \\<!channel\\> @\u{200b}everyone @\u{200b}here \\[Update now\\]\\(https://x.test\\) \\*b\\* \\& \\<@123\\>: 2 privacy changes\n2 privacy changes"
        );
        assert_eq!(discord["allowed_mentions"], json!({ "parse": [] }));
        let teams = build_payload("teams", &title, &lines, &rows);
        let escaped_title = "📱 Evil \\<!channel\\> @everyone @here \\[Update now\\]\\(https://x.test\\) \\*b\\* \\& \\<@123\\>: 2 privacy changes";
        assert_eq!(teams["title"], escaped_title);
        assert_eq!(teams["summary"], escaped_title);
        // Generic is JSON for an automation: the text as it is.
        let generic = build_payload("generic", &title, &lines, &rows);
        assert_eq!(generic["notifications"][0]["appName"], name);
        assert_eq!(generic["title"], title.as_str());
        assert_eq!(
            escape_markdown_text("a\\b`c_d~e|f#g-h"),
            "a\\\\b\\`c\\_d\\~e\\|f\\#g\\-h"
        );
    }

    #[test]
    fn discord_is_cut_at_nineteen_hundred_utf16_units() {
        // 1,000 astral characters are 2,000 UTF-16 units: over the cap,
        // cut at 950 characters, then the ellipsis.
        let long = "😀".repeat(1000);
        let out = build_payload("discord", &long, &[], &[]);
        let content = out["content"].as_str().unwrap();
        assert!(content.ends_with('…'));
        assert_eq!(content.chars().count(), 951);
        let short = build_payload("discord", "hi", &[], &[]);
        assert_eq!(short["content"], "hi\n");
    }
}
