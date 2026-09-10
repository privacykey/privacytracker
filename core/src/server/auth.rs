//! Port of `lib/admin-auth.cjs` — admin-token recognition.
//!
//! Two details a "tidier" Rust version gets wrong:
//!
//!   1. The length check happens BEFORE the constant-time compare. Node does
//!      `provided.length === secret.length && timingSafeEqual(...)` because
//!      `timingSafeEqual` THROWS on unequal lengths. A differing-length token
//!      is therefore a plain `false`, never an error.
//!   2. The cookie fallback only runs when the header is absent or wrong, it
//!      splits each cookie at the FIRST `=`, trims the name, and percent-
//!      decodes the value inside a try/catch that yields `false` on a
//!      malformed escape. A strict cookie parser accepts or rejects a
//!      different set of malformed inputs than this does.

use std::env;

pub const ADMIN_TOKEN_COOKIE: &str = "pt_admin_token";

/// `adminTokenConfigured()` — truthiness of the env var, so an empty string
/// counts as unconfigured exactly as `!!process.env.X` does.
pub fn admin_token_configured() -> bool {
    matches!(env::var("AUDITOR_ADMIN_TOKEN"), Ok(v) if !v.is_empty())
}

/// Constant-time comparison, guarded by a length pre-check.
fn matches_token(value: Option<&str>) -> bool {
    let Some(value) = value else { return false };
    let Ok(expected) = env::var("AUDITOR_ADMIN_TOKEN") else {
        return false;
    };
    if value.is_empty() || expected.is_empty() {
        return false;
    }
    let provided = value.as_bytes();
    let secret = expected.as_bytes();
    if provided.len() != secret.len() {
        return false;
    }
    // Constant-time over equal-length slices.
    let mut diff: u8 = 0;
    for (a, b) in provided.iter().zip(secret.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Minimal percent-decoder matching `decodeURIComponent`'s failure mode:
/// `None` on a malformed escape (which the Node code catches into `false`).
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `requestHasValidAdminToken` — header first, then the cookie.
pub fn request_has_valid_admin_token(header: Option<&str>, cookie_header: Option<&str>) -> bool {
    if matches_token(header) {
        return true;
    }
    for part in cookie_header.unwrap_or("").split(';') {
        let Some(sep) = part.find('=') else { continue };
        if part[..sep].trim() != ADMIN_TOKEN_COOKIE {
            continue;
        }
        // Node returns from inside the loop on the FIRST name match, so a
        // second pt_admin_token cookie is never consulted.
        return match percent_decode(part[sep + 1..].trim()) {
            Some(decoded) => matches_token(Some(&decoded)),
            None => false,
        };
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    // These mutate process env, so they run as one test to avoid races
    // between parallel test threads.
    #[test]
    fn token_recognition_matches_node() {
        env::set_var("AUDITOR_ADMIN_TOKEN", "s3cret");

        assert!(request_has_valid_admin_token(Some("s3cret"), None));
        assert!(!request_has_valid_admin_token(Some("wrong"), None));
        // Unequal length must be a plain false, never a panic.
        assert!(!request_has_valid_admin_token(Some("s3cre"), None));
        assert!(!request_has_valid_admin_token(Some("s3cretlonger"), None));
        assert!(!request_has_valid_admin_token(None, None));

        // Cookie fallback, including percent-decoding and the first-match rule.
        assert!(request_has_valid_admin_token(
            None,
            Some("pt_admin_token=s3cret")
        ));
        assert!(request_has_valid_admin_token(
            None,
            Some("a=1; pt_admin_token=s3cret; b=2")
        ));
        assert!(request_has_valid_admin_token(
            None,
            Some(" pt_admin_token = s3cret ")
        ));
        assert!(!request_has_valid_admin_token(
            None,
            Some("pt_admin_token=nope")
        ));
        // Malformed escape → false, not an error.
        assert!(!request_has_valid_admin_token(
            None,
            Some("pt_admin_token=%zz")
        ));
        // A non-matching cookie name is skipped entirely.
        assert!(!request_has_valid_admin_token(None, Some("other=s3cret")));

        assert!(admin_token_configured());
        env::remove_var("AUDITOR_ADMIN_TOKEN");
        assert!(!admin_token_configured());
        assert!(!request_has_valid_admin_token(Some("s3cret"), None));
    }
}
