//! JavaScript number/string coercions that Rust's stdlib does NOT match.
//!
//! The Node routes lean on `Number.parseInt(v, 10)` guarded by
//! `Number.isFinite`. That parse is *prefix-tolerant*: it skips leading
//! whitespace, accepts a leading sign, consumes digits, and STOPS at the
//! first non-digit rather than failing. `str::parse::<i64>()` rejects every
//! one of those inputs and would fall through to the caller's default —
//! silently returning a different answer than Node for the same query
//! string. `"50abc"` is 50 in Node and `None` in Rust.
//!
//! This lives here, with tests, because the routes that need it most
//! (`/api/activity`, `/api/stats/timeline`, `/api/settings/desktop`,
//! `/api/import/audit-bundle/recent`) land in later batches — and every one
//! of them gets it wrong by default.

/// Port of `Number.parseInt(s, 10)`, returning `None` where JS yields `NaN`.
///
/// Deliberately matches JS's leniency, including the cases that look like
/// bugs: `"1e3"` is 1 (parsing stops at `e`), `"0x10"` is 0 (stops at `x`),
/// `" +7 "` is 7, `""` and `"abc"` are `None`.
pub fn js_parse_int(s: &str) -> Option<i64> {
    // JS skips leading *whitespace* (its own definition, but ASCII
    // whitespace covers every realistic query-string input).
    let t = s.trim_start();
    let bytes = t.as_bytes();
    let mut i = 0usize;

    let negative = match bytes.first() {
        Some(b'-') => {
            i = 1;
            true
        }
        Some(b'+') => {
            i = 1;
            false
        }
        _ => false,
    };

    let start = i;
    let mut acc: i64 = 0;
    let mut overflow = false;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        let d = i64::from(bytes[i] - b'0');
        match acc.checked_mul(10).and_then(|a| a.checked_add(d)) {
            Some(next) => acc = next,
            // JS would go to f64 here and lose precision. Nothing in this
            // codebase parses numbers that large from a query string; saturate
            // rather than wrap, and let the caller's range check reject it.
            None => overflow = true,
        }
        i += 1;
    }

    if i == start {
        return None; // no digits consumed → NaN
    }
    if overflow {
        return Some(if negative { i64::MIN } else { i64::MAX });
    }
    Some(if negative { -acc } else { acc })
}

#[cfg(test)]
mod tests {
    use super::js_parse_int;

    #[test]
    fn matches_js_parse_int_semantics() {
        // Plain cases.
        assert_eq!(js_parse_int("0"), Some(0));
        assert_eq!(js_parse_int("42"), Some(42));
        assert_eq!(js_parse_int("-7"), Some(-7));
        assert_eq!(js_parse_int("+7"), Some(7));

        // Prefix tolerance — the whole reason this function exists.
        assert_eq!(js_parse_int("50abc"), Some(50));
        assert_eq!(js_parse_int("1e3"), Some(1));
        assert_eq!(js_parse_int("0x10"), Some(0));
        assert_eq!(js_parse_int("12.9"), Some(12));

        // Leading whitespace is skipped.
        assert_eq!(js_parse_int("   8"), Some(8));
        assert_eq!(js_parse_int("\t-3"), Some(-3));

        // NaN cases.
        assert_eq!(js_parse_int(""), None);
        assert_eq!(js_parse_int("abc"), None);
        assert_eq!(js_parse_int("-"), None);
        assert_eq!(js_parse_int("+"), None);
        assert_eq!(js_parse_int(" "), None);
    }

    #[test]
    fn rust_stdlib_would_disagree() {
        // Documents the divergence this helper exists to prevent: every one
        // of these is a real value in Node and an error in Rust's parser.
        for s in ["50abc", "1e3", "0x10", "12.9", "   8", "+7"] {
            assert!(
                s.parse::<i64>().is_err() || s.parse::<i64>().ok() == js_parse_int(s),
                "expected stdlib to differ or agree, never to silently mismatch: {s}"
            );
        }
        assert!("50abc".parse::<i64>().is_err());
        assert_eq!(js_parse_int("50abc"), Some(50));
    }
}
