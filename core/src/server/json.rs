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
            super::diag::log_error(format!("[server] response serialisation failed: {e}"));
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

/// Value-based operational reads can echo numbers outside i64 (stored
/// cooldowns and arbitrary runner totals). Preserve JS's decimal/exponent
/// thresholds instead of serde_json's f64 spelling. Other route families
/// retain their existing serializer until their own parity gates cover it.
pub(super) fn js_value_ok(value: &serde_json::Value) -> Response {
    fn write(v: &serde_json::Value, out: &mut String) {
        use serde_json::Value;
        match v {
            Value::Number(n) => {
                let f = n.as_f64().unwrap_or(f64::NAN);
                if !f.is_finite() {
                    out.push_str("null");
                } else if f == 0.0 {
                    out.push('0');
                } else {
                    let decimal = f.abs().to_string();
                    if f < 0.0 {
                        out.push('-');
                    }
                    if (1e-6..1e21).contains(&f.abs()) {
                        out.push_str(&decimal);
                    } else {
                        let point = decimal.find('.').unwrap_or(decimal.len());
                        let digits = decimal.replace('.', "");
                        let first = digits.find(|c| c != '0').unwrap();
                        let significant = digits[first..].trim_end_matches('0');
                        out.push_str(&significant[..1]);
                        if significant.len() > 1 {
                            out.push('.');
                            out.push_str(&significant[1..]);
                        }
                        let exp = point as i32 - first as i32 - 1;
                        out.push('e');
                        if exp >= 0 {
                            out.push('+');
                        }
                        out.push_str(&exp.to_string());
                    }
                }
            }
            Value::Array(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(v, out);
                }
                out.push(']');
            }
            Value::Object(m) => {
                out.push('{');
                for (i, (k, v)) in m.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap());
                    out.push(':');
                    write(v, out);
                }
                out.push('}');
            }
            _ => out.push_str(&v.to_string()),
        }
    }
    let mut body = String::new();
    write(value, &mut body);
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .expect("JSON response")
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
