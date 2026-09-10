//! Response construction, matching `NextResponse.json`.
//!
//! Node emits compact JSON with no trailing newline and does not escape
//! non-ASCII; `serde_json::to_vec` matches on both counts. The parity differ
//! compares status first and then the body, so the status code is as much
//! part of the contract as the bytes.

use axum::{
    body::Body,
    http::{header, StatusCode},
    response::Response,
};
use serde::Serialize;

/// `NextResponse.json(value, { status })`.
pub fn json_response<T: Serialize>(status: StatusCode, value: &T) -> Response {
    let body = match serde_json::to_vec(value) {
        Ok(b) => b,
        // Serialising our own response types cannot realistically fail; if it
        // somehow does, say so rather than emitting a half-written body.
        Err(e) => {
            eprintln!("[server] response serialisation failed: {e}");
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"error":"Internal Server Error"}"#))
                .expect("static error response");
        }
    };
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .expect("response builder")
}

/// 200 with a JSON body.
pub fn json_ok<T: Serialize>(value: &T) -> Response {
    json_response(StatusCode::OK, value)
}

/// The `{ "error": "…" }` shape every gate rejection and route 404 uses. The
/// strings are compared byte-for-byte by the parity harness, so they are
/// copied verbatim from the Node source rather than paraphrased.
pub fn json_error(status: StatusCode, message: &str) -> Response {
    #[derive(Serialize)]
    struct ErrorBody<'a> {
        error: &'a str,
    }
    json_response(status, &ErrorBody { error: message })
}
