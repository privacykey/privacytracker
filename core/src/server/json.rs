//! Response construction, matching `NextResponse.json`.
//!
//! Node emits compact JSON with no trailing newline and does not escape
//! non-ASCII; `serde_json`'s compact serializer matches on both counts. Its
//! NUMBER spelling does not: `ryu` writes `1e16`, `1e-6` and `1e21` where
//! `JSON.stringify` writes `10000000000000000`, `0.000001` and `1e+21`, and
//! an i64 past 2^53 is written exactly where JavaScript, which never held it
//! exactly, writes the nearest double. So every response body goes through
//! ONE serializer — `serde_json` with a formatter whose numbers are spelled
//! by `jsnum::js_number_spelling` — and there is deliberately no second
//! writer per route family. The parity differ compares status first and
//! then the body, so the status code is as much part of the contract as
//! the bytes.

use crate::jsnum::js_number_spelling;
use axum::{
    body::Body,
    http::{header, StatusCode},
    response::Response,
};
use serde::Serialize;
use serde_json::ser::Formatter;
use std::io;

/// `serde_json`'s compact formatter with JavaScript's number spelling.
struct JsFormatter;

impl Formatter for JsFormatter {
    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(js_number_spelling(value).as_bytes())
    }

    // JavaScript has one number type: an integer is spelled as the double it
    // parses to, which only differs from the exact digits past 2^53.
    fn write_i64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: i64) -> io::Result<()> {
        writer.write_all(js_number_spelling(value as f64).as_bytes())
    }

    fn write_u64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: u64) -> io::Result<()> {
        writer.write_all(js_number_spelling(value as f64).as_bytes())
    }
}

/// `JSON.stringify(value)`: compact, non-ASCII unescaped, JS number spelling.
pub fn js_json_vec<T: Serialize>(value: &T) -> serde_json::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(128);
    let mut ser = serde_json::Serializer::with_formatter(&mut out, JsFormatter);
    value.serialize(&mut ser)?;
    Ok(out)
}

/// `NextResponse.json(value, { status })`.
pub fn json_response<T: Serialize>(status: StatusCode, value: &T) -> Response {
    let body = match js_json_vec(value) {
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

#[cfg(test)]
mod tests {
    use super::js_json_vec;
    use serde_json::json;

    #[test]
    fn one_serializer_spells_numbers_like_javascript() {
        // `JSON.stringify` of the same object from node -e. serde_json's own
        // formatter would write 1e16, 1e21, 1e-6 and the exact 2^53+1 here.
        let v = json!({
            "plain": [1, 2.5, -3, 0.1],
            "big": [1e16, 1e21, 9_007_199_254_740_993_i64],
            "small": [0.000001, 1e-7],
            "s": "é",
            "n": null
        });
        assert_eq!(
            String::from_utf8(js_json_vec(&v).unwrap()).unwrap(),
            r#"{"plain":[1,2.5,-3,0.1],"big":[10000000000000000,1e+21,9007199254740992],"small":[0.000001,1e-7],"s":"é","n":null}"#
        );
    }
}
