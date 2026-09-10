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

/// Port of the `Number(x)` conversion, for a value that came out of SQLite.
///
/// Returns `f64::NAN` where JS yields `NaN`, so callers can reproduce
/// `Number(x) || 0` faithfully — that idiom folds NaN, `null`, `""` and `0`
/// onto the same answer, and each of those reaches it by a different route.
///
/// Deliberately narrower than the spec at the edges JS reaches and SQLite
/// cannot: no hex/octal/binary string literals, no `"Infinity"`. A column
/// holding one of those is not a case this database can produce, and
/// pretending otherwise would be untested code.
pub fn js_to_number(value: &serde_json::Value) -> f64 {
    use serde_json::Value;
    match value {
        Value::Null => 0.0,
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                // `Number("")` and `Number("   ")` are 0, not NaN.
                return 0.0;
            }
            // Rust accepts "inf"/"infinity"/"nan"; JavaScript does not.
            if t.eq_ignore_ascii_case("nan")
                || t.eq_ignore_ascii_case("inf")
                || t.eq_ignore_ascii_case("infinity")
                || t.eq_ignore_ascii_case("+inf")
                || t.eq_ignore_ascii_case("-inf")
            {
                return f64::NAN;
            }
            t.parse::<f64>().unwrap_or(f64::NAN)
        }
        // `Number([])` is 0 and `Number([7])` is 7, via toString; anything
        // longer, and every plain object, is NaN.
        Value::Array(items) => match items.len() {
            0 => 0.0,
            1 => js_to_number(&items[0]),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

/// Render an f64 the way `JSON.stringify` renders a JavaScript number.
///
/// The important case is the boring one: JS has a single number type, so an
/// integral value serialises WITHOUT a decimal point. `serde_json` would
/// write `1787843602839.0` for the same f64, which is a byte difference on
/// every timestamp the API returns.
pub fn js_number(f: f64) -> serde_json::Value {
    use serde_json::Value;
    if f.is_nan() || f.is_infinite() {
        // JSON.stringify(NaN) is the four characters `null`.
        return Value::Null;
    }
    // 2^53 — beyond it, integral f64s are no longer exactly representable
    // and JS itself starts printing them in exponent form.
    if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
        return Value::from(f as i64);
    }
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests {
    use super::{js_number, js_parse_int, js_to_number};
    use serde_json::{json, Value};

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

    #[test]
    fn number_coercion_matches_javascript() {
        assert_eq!(js_to_number(&Value::Null), 0.0);
        assert_eq!(js_to_number(&json!(0)), 0.0);
        assert_eq!(
            js_to_number(&json!(1_787_843_602_839i64)),
            1_787_843_602_839.0
        );
        // Text columns: JS coerces the whole string or gives NaN — unlike
        // parseInt, there is no prefix tolerance here.
        assert_eq!(js_to_number(&json!("123")), 123.0);
        assert_eq!(js_to_number(&json!(" 1.9 ")), 1.9);
        assert_eq!(js_to_number(&json!("")), 0.0);
        assert_eq!(js_to_number(&json!("   ")), 0.0);
        assert!(js_to_number(&json!("12abc")).is_nan());
        assert!(js_to_number(&json!("abc")).is_nan());
        // Rust's parser accepts these; JavaScript's does not.
        assert!(js_to_number(&json!("inf")).is_nan());
        assert!(js_to_number(&json!("NaN")).is_nan());
        assert_eq!(js_to_number(&json!(true)), 1.0);
        assert_eq!(js_to_number(&json!([])), 0.0);
        assert!(js_to_number(&json!({})).is_nan());
    }

    #[test]
    fn the_number_or_zero_idiom_folds_four_inputs_together() {
        // `Number(x) || 0` — this is what every caller actually wants.
        let or_zero = |v: &Value| {
            let n = js_to_number(v);
            if n.is_nan() || n == 0.0 {
                0.0
            } else {
                n
            }
        };
        for v in [Value::Null, json!(0), json!(""), json!("abc"), json!({})] {
            assert_eq!(or_zero(&v), 0.0, "{v} should collapse to 0");
        }
        assert_eq!(or_zero(&json!("1.9")), 1.9);
    }

    #[test]
    fn integral_numbers_serialise_without_a_decimal_point() {
        // The whole reason js_number exists: serde_json would write "1.0".
        assert_eq!(js_number(1.0).to_string(), "1");
        assert_eq!(js_number(0.0).to_string(), "0");
        assert_eq!(js_number(-3.0).to_string(), "-3");
        assert_eq!(js_number(1_787_843_602_839.0).to_string(), "1787843602839");
        assert_eq!(js_number(1.9).to_string(), "1.9");
        // JSON.stringify(NaN) === "null".
        assert_eq!(js_number(f64::NAN), Value::Null);
        assert_eq!(js_number(f64::INFINITY), Value::Null);
    }
}
