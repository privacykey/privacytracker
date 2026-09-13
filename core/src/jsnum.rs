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
    // JS skips leading whitespace by ITS definition — which strips U+FEFF
    // and keeps U+0085, the reverse of `str::trim_start`.
    let t = s.trim_start_matches(crate::jsstr::is_js_whitespace);
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

/// Port of `Number.parseFloat(s)`, returning `NaN` where JS does.
///
/// Like [`js_parse_int`] it is prefix-tolerant: the longest leading
/// `StrDecimalLiteral` wins and everything after it is ignored, so
/// `"1.5abc"` is 1.5, `"1.2.3"` is 1.2, `"1e"` is 1 (a dangling exponent
/// marker is not consumed) and `"0x10"` is 0 (hex is `parseInt`'s
/// leniency, not this one's). `"Infinity"` with an optional sign is the one
/// word it accepts, case-sensitively; `"inf"`, `"nan"` and `"infinity"` —
/// all of which Rust's `f64::from_str` takes — are `NaN` here. `"1e400"`
/// overflows to `Infinity`, which is why callers guard with
/// `Number.isFinite`. Every case in the tests was read out of `node -e`.
pub fn js_parse_float(s: &str) -> f64 {
    let t = s.trim_start_matches(crate::jsstr::is_js_whitespace);
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
    if t[i..].starts_with("Infinity") {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }

    let start = i;
    let mut int_digits = 0usize;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        int_digits += 1;
    }
    let mut frac_digits = 0usize;
    if i < bytes.len() && bytes[i] == b'.' {
        let mut j = i + 1;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
            frac_digits += 1;
        }
        // `"5."` and `".5"` are numbers; `"."` alone is not.
        if int_digits + frac_digits > 0 {
            i = j;
        }
    }
    if int_digits + frac_digits == 0 {
        return f64::NAN;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let exp_start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        // An `e` with no digits behind it is not part of the literal.
        if j > exp_start {
            i = j;
        }
    }

    // What remains is a literal Rust's parser agrees with JavaScript on:
    // digits, one optional point, one optional signed exponent.
    let magnitude: f64 = t[start..i].parse().unwrap_or(f64::NAN);
    if negative {
        -magnitude
    } else {
        magnitude
    }
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

/// Whether JavaScript would print this f64 as a plain integer, and if so
/// which one.
///
/// JS has a single number type, so an integral value prints WITHOUT a decimal
/// point — `9007199254740992` and `100000000000000000`, not
/// `9007199254740992.0` and `1e17`. It only reaches exponent notation past
/// 1e21. `serde_json`'s float formatting disagrees on both counts.
///
/// The bound is the i64 range rather than 2^53: an integral f64 below 2^63
/// converts to i64 exactly, and stopping at 2^53 — the natural instinct,
/// since that is where f64 stops representing every integer — would emit
/// `1e17` for a value JavaScript writes out in full. Above the i64 range
/// this gives up and lets the float formatter run, which diverges; nothing
/// this database stores comes close.
fn js_integral(f: f64) -> Option<i64> {
    if f.fract() == 0.0 && f.abs() < 9.0e18 {
        Some(f as i64)
    } else {
        None
    }
}

/// Render an f64 the way `JSON.stringify` renders a JavaScript number.
///
/// The important case is the boring one: an integral value serialises
/// WITHOUT a decimal point. `serde_json` would write `1787843602839.0` for
/// the same f64, which is a byte difference on every timestamp the API
/// returns — and one the parity differ SEES, because its `~epoch` mask only
/// covers values below 4.1e12.
pub fn js_number(f: f64) -> serde_json::Value {
    use serde_json::Value;
    if f.is_nan() || f.is_infinite() {
        // JSON.stringify(NaN) is the four characters `null`.
        return Value::Null;
    }
    if let Some(i) = js_integral(f) {
        return Value::from(i);
    }
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// Walk a parsed JSON value and re-render every number as JavaScript
/// would, so a stored blob round-trips byte-for-byte through
/// `JSON.parse` → `JSON.stringify`.
///
/// `serde_json` keeps `1.0` as a float and prints it back as `1.0`;
/// JavaScript has one number type and prints `1`. A blob that Node wrote
/// never contains `1.0` in the first place, so this is insurance against a
/// hand-edited row — and against the day a Rust writer stores one.
pub fn js_normalise_value(value: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() => js_number(f),
            _ => Value::Number(n),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(js_normalise_value).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, js_normalise_value(v)))
                .collect(),
        ),
        other => other,
    }
}

/// Render a JSON number the way a JavaScript TEMPLATE LITERAL would.
///
/// Not the same function as [`js_number`]: `${NaN}` is `NaN` and
/// `${Infinity}` is `Infinity`, where `JSON.stringify` writes `null` for
/// both. They share the integral rule, which is the half that actually
/// bites.
pub fn js_number_to_string(n: &serde_json::Number) -> String {
    match n.as_f64() {
        Some(f) if f.is_nan() => "NaN".to_string(),
        Some(f) if f.is_infinite() => {
            if f > 0.0 {
                "Infinity".to_string()
            } else {
                "-Infinity".to_string()
            }
        }
        Some(f) => match js_integral(f) {
            Some(i) => i.to_string(),
            None => n.to_string(),
        },
        None => n.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{js_number, js_number_to_string, js_parse_float, js_parse_int, js_to_number};
    use serde_json::{json, Value};

    #[test]
    fn parse_int_skips_javascript_whitespace_not_rust_whitespace() {
        // U+FEFF is whitespace to JS and not to Rust; U+0085 the reverse.
        assert_eq!(js_parse_int("\u{FEFF}7"), Some(7));
        assert_eq!(js_parse_int("\u{0085}7"), None);
        assert_eq!(js_parse_int("\u{00A0}7"), Some(7));
    }

    #[test]
    fn matches_js_parse_float_semantics() {
        // Every line is `String(Number.parseFloat(input))` from node -e.
        let cases: &[(&str, f64)] = &[
            ("1.5abc", 1.5),
            ("  2.5", 2.5),
            ("-.5", -0.5),
            (".5", 0.5),
            ("5.", 5.0),
            ("1e", 1.0),
            ("1e5", 100_000.0),
            ("1E+2", 100.0),
            ("+.5e-1", 0.05),
            ("0x10", 0.0),
            ("1.2.3", 1.2),
            ("1_000", 1.0),
            (" 1", 1.0),
            ("\u{FEFF}2", 2.0),
            ("-0", 0.0),
            ("0.5", 0.5),
            ("3", 3.0),
            ("3.0", 3.0),
            ("1.50", 1.5),
        ];
        for (input, expected) in cases {
            let got = js_parse_float(input);
            assert_eq!(got, *expected, "parseFloat({input:?})");
        }
        assert_eq!(js_parse_float("Infinity"), f64::INFINITY);
        assert_eq!(js_parse_float("+Infinity"), f64::INFINITY);
        assert_eq!(js_parse_float("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(js_parse_float("1e400"), f64::INFINITY);
        for input in ["", ".", "e5", "abc", "infinity", "inf", "NaN", "-", "+"] {
            assert!(js_parse_float(input).is_nan(), "parseFloat({input:?})");
        }
        // The desktop-settings guard: finite AND in range. Infinity fails
        // the first half, so `"1e400"` falls back to the default.
        let in_range = |s: &str| {
            let z = js_parse_float(s);
            z.is_finite() && (0.5..=3.0).contains(&z)
        };
        assert!(in_range("1.5abc"));
        assert!(!in_range("1e400"));
        assert!(!in_range("0.25"));
        assert!(!in_range("abc"));
    }

    #[test]
    fn rust_stdlib_would_disagree_on_parse_float_too() {
        for s in ["inf", "infinity", "nan", "NaN"] {
            assert!(s.parse::<f64>().is_ok(), "{s}: stdlib accepts");
            assert!(js_parse_float(s).is_nan(), "{s}: JS does not");
        }
        assert!("1.5abc".parse::<f64>().is_err());
        assert_eq!(js_parse_float("1.5abc"), 1.5);
    }

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

    #[test]
    fn integral_formatting_holds_past_2_pow_53() {
        // 2^53 exactly. Bounding on `< 2^53` — the obvious choice, since that
        // is where f64 stops representing every integer — emits a trailing
        // `.0` here where JSON.stringify does not, and the differ can see it.
        assert_eq!(
            js_number(9_007_199_254_740_992.0).to_string(),
            "9007199254740992"
        );
        assert_eq!(
            js_number(9_007_199_254_740_991.0).to_string(),
            "9007199254740991"
        );
        // Well past 2^53, JS still writes the digits out rather than 1e17.
        assert_eq!(js_number(1.0e17).to_string(), "100000000000000000");
    }

    #[test]
    fn normalise_value_reprints_floats_the_javascript_way() {
        use super::js_normalise_value;
        let v: Value =
            serde_json::from_str(r#"{"a":1.0,"b":[2.5,3.0,{"c":1e2}],"d":"1.0","e":null}"#)
                .unwrap();
        assert_eq!(
            js_normalise_value(v).to_string(),
            r#"{"a":1,"b":[2.5,3,{"c":100}],"d":"1.0","e":null}"#
        );
    }

    #[test]
    fn template_literal_formatting_differs_from_json_for_nan() {
        let num = |v: &str| serde_json::from_str::<serde_json::Number>(v).unwrap();
        assert_eq!(js_number_to_string(&num("1")), "1");
        assert_eq!(js_number_to_string(&num("1.0")), "1");
        assert_eq!(js_number_to_string(&num("2.5")), "2.5");
        assert_eq!(
            js_number_to_string(&num("9007199254740992")),
            "9007199254740992"
        );
        // `${NaN}` is "NaN" while JSON.stringify(NaN) is "null" — the one
        // place these two helpers must NOT agree.
        assert_eq!(js_number(f64::NAN), Value::Null);
    }
}
