//! `readBoundedJson` from lib/request-body.ts: the declared Content-Length
//! is refused before a byte is read, the stream is capped as it arrives,
//! an empty body and unparseable JSON are distinct failures, and the
//! whole read has thirty seconds. Every write route maps the outcomes to
//! its own 400 message; the 413 and 408 bodies are shared
//! (`requestBodyErrorResponse`).
use super::json::json_error;
use crate::jsnum::js_to_number;
use axum::{
    body::Body,
    http::{header, HeaderMap, StatusCode},
    response::Response,
};
use serde_json::Value;
use std::time::Duration;

const BODY_TIMEOUT: Duration = Duration::from_secs(30);

pub enum BodyOutcome {
    Json(Value),
    /// `Request body is empty`.
    Empty,
    /// `Invalid JSON body`.
    Invalid,
    /// Bytes that are only whitespace: `JSON.parse` fails, but the optional
    /// reader treats it as no body at all.
    Whitespace,
    /// `Request body too large (limit N bytes)` — a 413.
    TooLarge(usize),
    /// `Request body timed out` — a 408.
    Timeout,
    /// The bytes as they arrived, for the one route that takes a
    /// `multipart/form-data` upload and parses it itself.
    Raw(Vec<u8>),
}

/// `readBoundedBody`: the declared length refused first, then the stream
/// under the cap and the clock. `Err` is the 413 or the 408.
async fn read_bytes(
    headers: &HeaderMap,
    body: Body,
    max_bytes: usize,
) -> Result<axum::body::Bytes, BodyOutcome> {
    // `Number(request.headers.get("content-length") ?? "")`: an absent or
    // empty header is 0, junk is NaN, and only a finite excess refuses.
    if let Some(declared) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
    {
        let n = js_to_number(&Value::String(declared.to_string()));
        if n.is_finite() && n > max_bytes as f64 {
            return Err(BodyOutcome::TooLarge(max_bytes));
        }
    }
    match tokio::time::timeout(BODY_TIMEOUT, axum::body::to_bytes(body, max_bytes)).await {
        Err(_) => Err(BodyOutcome::Timeout),
        // The only error the capped reader raises on a live connection is
        // the cap itself; a reset mid-body is reported the same way.
        Ok(Err(_)) => Err(BodyOutcome::TooLarge(max_bytes)),
        Ok(Ok(bytes)) => Ok(bytes),
    }
}

/// The body unparsed, under `max_bytes`.
pub async fn read_raw(headers: &HeaderMap, body: Body, max_bytes: usize) -> BodyOutcome {
    match read_bytes(headers, body, max_bytes).await {
        Ok(bytes) => BodyOutcome::Raw(bytes.to_vec()),
        Err(refused) => refused,
    }
}

/// Read and parse a JSON body under `max_bytes`.
pub async fn read_json(headers: &HeaderMap, body: Body, max_bytes: usize) -> BodyOutcome {
    let bytes = match read_bytes(headers, body, max_bytes).await {
        Ok(bytes) => bytes,
        Err(refused) => return refused,
    };
    if bytes.is_empty() {
        return BodyOutcome::Empty;
    }
    // `body.toString("utf8")` is lossy, then `JSON.parse`.
    let text = String::from_utf8_lossy(&bytes);
    match serde_json::from_str::<Value>(&text) {
        Ok(value) => BodyOutcome::Json(value),
        Err(_) if crate::jsstr::js_trim(&text).is_empty() => BodyOutcome::Whitespace,
        Err(_) => BodyOutcome::Invalid,
    }
}

/// `requestBodyErrorResponse`: the two outcomes with a response of their
/// own; the others are each route's to phrase.
pub fn body_error_response(outcome: &BodyOutcome) -> Option<Response> {
    match outcome {
        BodyOutcome::TooLarge(max) => Some(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!("Request body too large (limit {max} bytes)"),
        )),
        BodyOutcome::Timeout => Some(json_error(
            StatusCode::REQUEST_TIMEOUT,
            "Request body timed out",
        )),
        _ => None,
    }
}
