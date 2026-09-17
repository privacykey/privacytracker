//! `multipart/form-data`, as far as one route needs it: `POST
//! /api/import/audit-bundle` takes the bundle as a file field, and Node
//! reads it with `new Response(body, { headers }).formData()` — undici's
//! parser. This follows that parser's steps rather than the RFC's, because
//! the differences are observable: a preamble before the first delimiter
//! and an epilogue after the last are both ignored, a part's body ends
//! four bytes before the next occurrence of the BARE boundary string, and
//! a part is a file exactly when its `Content-Disposition` carries a
//! `filename`.
//!
//! axum's own `multipart` feature is deliberately not enabled (see
//! Cargo.toml): it would add a dependency and a streaming extractor for
//! what is here eighty lines over a body already capped and in memory.

/// One form entry. `filename` is what makes it a `File` rather than a
/// string in the `FormData` Node builds.
pub(super) struct Part {
    pub(super) name: String,
    pub(super) filename: Option<String>,
    pub(super) body: Vec<u8>,
}

/// The `boundary` parameter of a `multipart/form-data` content type,
/// quoted or bare, wherever it sits among the parameters.
pub(super) fn boundary_of(content_type: &str) -> Option<String> {
    content_type.split(';').skip(1).find_map(|param| {
        let (key, value) = param.split_once('=')?;
        if !key.trim().eq_ignore_ascii_case("boundary") {
            return None;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .unwrap_or(value);
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

fn is_crlf(input: &[u8], at: usize) -> bool {
    input.get(at) == Some(&b'\r') && input.get(at + 1) == Some(&b'\n')
}

/// One `name="value"` or `name=token` attribute of a content disposition.
fn attribute(line: &str, wanted: &str) -> Option<String> {
    line.split(';').skip(1).find_map(|attr| {
        let (key, value) = attr.split_once('=')?;
        if !key.trim().eq_ignore_ascii_case(wanted) {
            return None;
        }
        let value = value.trim();
        Some(match value.strip_prefix('"') {
            Some(rest) => rest.split('"').next().unwrap_or("").to_string(),
            None => value.to_string(),
        })
    })
}

/// `multipartFormDataParser`: every entry in order, or `Err` where undici
/// throws — which the route reports as one message whatever the cause.
pub(super) fn parse(input: &[u8], boundary: &str) -> Result<Vec<Part>, &'static str> {
    let delimiter = format!("--{boundary}").into_bytes();
    let bare = boundary.as_bytes();
    // Anything before the first delimiter is preamble.
    let mut pos = find(input, &delimiter, 0).ok_or("no boundary found in multipart body")?;
    let mut parts = Vec::new();
    loop {
        if !input[pos..].starts_with(&delimiter) {
            return Err("expected a value starting with -- and the boundary");
        }
        pos += delimiter.len();
        // The closing delimiter; whatever follows is epilogue.
        if input[pos..].starts_with(b"--") {
            return Ok(parts);
        }
        if !is_crlf(input, pos) {
            return Err("expected CRLF");
        }
        pos += 2;

        let (mut name, mut filename) = (None, None);
        while !is_crlf(input, pos) {
            let end = find(input, b"\r\n", pos).ok_or("unterminated header")?;
            let line = String::from_utf8_lossy(&input[pos..end]);
            if let Some((header, value)) = line.split_once(':') {
                if header.trim().eq_ignore_ascii_case("content-disposition") {
                    if !value
                        .trim_start()
                        .to_ascii_lowercase()
                        .starts_with("form-data")
                    {
                        return Err("expected form-data for content-disposition header");
                    }
                    name = attribute(value, "name");
                    filename = attribute(value, "filename");
                }
            } else {
                return Err("expected :");
            }
            pos = end + 2;
        }
        let name = name.ok_or("header name is null")?;
        pos += 2;

        // The body runs to four bytes before the next BARE boundary: the
        // CRLF and the two dashes that precede it.
        let next = find(input, bare, pos).ok_or("expected boundary after body")?;
        let end = next.saturating_sub(4).max(pos);
        let body = input[pos..end].to_vec();
        pos = end;
        if !is_crlf(input, pos) {
            return Err("expected CRLF");
        }
        pos += 2;
        parts.push(Part {
            name,
            filename,
            body,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const B: &str = "----ptBoundary0123456789abcdef";

    fn file(content: &str) -> String {
        format!(
            "--{B}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.json\"\r\nContent-Type: application/json\r\n\r\n{content}\r\n"
        )
    }

    #[test]
    fn the_boundary_parameter_is_found_quoted_or_bare() {
        assert_eq!(
            boundary_of("multipart/form-data; boundary=abc").as_deref(),
            Some("abc")
        );
        assert_eq!(
            boundary_of("multipart/form-data; charset=utf-8; Boundary=\"a b\"").as_deref(),
            Some("a b")
        );
        assert_eq!(boundary_of("multipart/form-data"), None);
        assert_eq!(boundary_of("multipart/form-data; boundary="), None);
    }

    #[test]
    fn parts_come_back_in_order_with_their_bytes() {
        let body = format!(
            "preamble\r\n--{B}\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nhi\r\n{}--{B}--\r\nepilogue",
            file("{\"a\":1}")
        );
        let parts = parse(body.as_bytes(), B).unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(
            (parts[0].name.as_str(), &parts[0].filename),
            ("note", &None)
        );
        assert_eq!(parts[0].body, b"hi");
        assert_eq!(parts[1].filename.as_deref(), Some("a.json"));
        assert_eq!(parts[1].body, b"{\"a\":1}");
    }

    #[test]
    fn a_body_that_never_closes_or_uses_another_boundary_is_an_error() {
        assert!(parse(file("{}").as_bytes(), B).is_err());
        let closed = format!("{}--{B}--\r\n", file("{}"));
        assert!(parse(closed.as_bytes(), "someOtherBoundary").is_err());
        assert!(parse(format!("--{B}--\r\n").as_bytes(), B)
            .unwrap()
            .is_empty());
    }
}
