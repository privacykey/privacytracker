//! JavaScript string and object semantics that Rust's stdlib does NOT match.
//!
//! Sibling of `jsnum.rs`. Each helper exists because a natural Rust spelling
//! gives a different answer on real inputs, verified against Node.

use serde_json::Value;

/// The characters JavaScript's `\s` and `String.prototype.trim` treat as
/// whitespace. Differs from `char::is_whitespace` in exactly two places,
/// both verified against Node 26 and rustc:
///
/// * **U+FEFF** (BOM / ZWNBSP): JS strips it; Rust does not.
/// * **U+0085** (NEL): Rust strips it; JS does not.
pub fn is_js_whitespace(c: char) -> bool {
    match c {
        '\u{FEFF}' => true,
        '\u{0085}' => false,
        _ => c.is_whitespace(),
    }
}

/// `typeof v !== "string" ? "" : v.replace(/\s+/g, " ").trim()` — the
/// `cleanSentence` helper that every free-text field in the policy summary
/// passes through.
pub fn clean_sentence(v: Option<&Value>) -> String {
    let Some(Value::String(s)) = v else {
        return String::new();
    };
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if is_js_whitespace(c) {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    // `.trim()` after the collapse can only ever remove one leading and one
    // trailing space, but do it the JS way rather than assuming.
    out.trim_matches(is_js_whitespace).to_string()
}

/// `String.prototype.length` — UTF-16 code units, not chars or bytes.
pub fn js_length(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, n)` in UTF-16 code units.
///
/// JavaScript happily cuts a surrogate pair in half; the result is a string
/// with a lone high surrogate, which `JSON.stringify` emits as `\ud83d`. A
/// Rust `String` cannot hold that, so when the cut lands inside a pair the
/// pair is dropped — one character shorter than Node on that one input, and
/// the only way to stay representable. No stored policy text is expected to
/// straddle the cut at an emoji; this is recorded so the divergence is
/// chosen, not discovered.
pub fn js_slice_prefix(s: &str, n: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for c in s.chars() {
        let w = c.len_utf16();
        if units + w > n {
            break;
        }
        units += w;
        out.push(c);
    }
    out
}

/// Whether a JavaScript property key is an *array index* — the canonical
/// decimal form of an integer in `0..=2^32-2`. Such keys are enumerated
/// FIRST, in ascending numeric order, regardless of insertion; everything
/// else follows in insertion order. Verified: `"01"`, `"-1"` and
/// `"4294967295"` are all string keys.
pub fn is_array_index_key(k: &str) -> bool {
    if k.is_empty() || k.len() > 10 {
        return false;
    }
    if k == "0" {
        return true;
    }
    if k.starts_with('0') || !k.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    k.parse::<u64>()
        .map(|n| n <= 4_294_967_294)
        .unwrap_or(false)
}

/// Order a set of keys the way `Object.keys` / `JSON.stringify` would walk
/// them: array-index keys ascending, then the rest in the order given.
pub fn js_object_key_order<'a>(insertion_order: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut numeric: Vec<(u64, &str)> = Vec::new();
    let mut rest: Vec<&str> = Vec::new();
    for k in insertion_order {
        if is_array_index_key(k) {
            numeric.push((k.parse().unwrap_or(0), k));
        } else {
            rest.push(k);
        }
    }
    numeric.sort_by_key(|(n, _)| *n);
    numeric.into_iter().map(|(_, k)| k).chain(rest).collect()
}

/// Build a JSON object from `(key, value)` pairs, emitting keys in JS
/// property order rather than insertion order. Use this for any Node object
/// keyed by app ids: the seed's numeric ids will sort ascending while the
/// parity fixture's `pt-fixture-*` ids trail in insertion order, and a
/// plain insertion-ordered map gets that wrong on every mixed page.
pub fn js_keyed_object(pairs: Vec<(String, Value)>) -> Value {
    let order: Vec<String> = js_object_key_order(pairs.iter().map(|(k, _)| k.as_str()))
        .into_iter()
        .map(str::to_string)
        .collect();
    let mut by_key: std::collections::HashMap<String, Value> = pairs.into_iter().collect();
    let mut map = serde_json::Map::with_capacity(order.len());
    for k in order {
        if let Some(v) = by_key.remove(&k) {
            map.insert(k, v);
        }
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn whitespace_matches_javascript_on_the_two_characters_that_differ() {
        assert!(
            is_js_whitespace('\u{FEFF}'),
            "JS strips the BOM; Rust does not"
        );
        assert!(
            !is_js_whitespace('\u{0085}'),
            "Rust strips NEL; JS does not"
        );
        for c in [' ', '\u{00A0}', '\u{2028}', '\u{3000}', '\t', '\n'] {
            assert!(is_js_whitespace(c));
        }
        for c in ['\u{200B}', '\u{180E}', '\u{001C}', '\u{001F}', 'x'] {
            assert!(!is_js_whitespace(c));
        }
    }

    #[test]
    fn clean_sentence_collapses_runs_and_trims_the_js_way() {
        assert_eq!(clean_sentence(Some(&json!("  a \t\n b  "))), "a b");
        assert_eq!(clean_sentence(Some(&json!("\u{FEFF}x\u{FEFF}"))), "x");
        // NEL is NOT whitespace to JS, so it survives.
        assert_eq!(clean_sentence(Some(&json!("a\u{0085}b"))), "a\u{0085}b");
        // Non-strings are the empty string, not a stringification.
        assert_eq!(clean_sentence(Some(&json!(42))), "");
        assert_eq!(clean_sentence(Some(&Value::Null)), "");
        assert_eq!(clean_sentence(None), "");
    }

    #[test]
    fn length_and_slice_count_utf16_units() {
        // "a" + U+1F600 (astral, 2 units) + "b"
        let s = "a\u{1F600}b";
        assert_eq!(js_length(s), 4);
        assert_eq!(js_slice_prefix(s, 1), "a");
        assert_eq!(js_slice_prefix(s, 3), "a\u{1F600}");
        // A cut inside the pair drops the pair rather than emitting a lone
        // surrogate — the documented divergence.
        assert_eq!(js_slice_prefix(s, 2), "a");
        assert_eq!(js_slice_prefix(s, 99), s);
    }

    #[test]
    fn array_index_keys_are_exactly_the_canonical_integers_below_2_pow_32_minus_1() {
        for k in ["0", "2", "10", "94961186", "4294967294"] {
            assert!(is_array_index_key(k), "{k}");
        }
        for k in [
            "",
            "01",
            "-1",
            "4294967295",
            "1e3",
            "pt-fixture-a",
            " 1",
            "1.0",
        ] {
            assert!(!is_array_index_key(k), "{k}");
        }
    }

    #[test]
    fn key_order_matches_node() {
        // Node: Object.keys of insertion ["pt-fixture-b","94961186","10",
        // "pt-fixture-a","2","4294967295","4294967296","-1","01"]
        let got = js_object_key_order([
            "pt-fixture-b",
            "94961186",
            "10",
            "pt-fixture-a",
            "2",
            "4294967295",
            "4294967296",
            "-1",
            "01",
        ]);
        assert_eq!(
            got,
            [
                "2",
                "10",
                "94961186",
                "pt-fixture-b",
                "pt-fixture-a",
                "4294967295",
                "4294967296",
                "-1",
                "01"
            ]
        );
    }

    #[test]
    fn keyed_object_serialises_in_js_order() {
        let v = js_keyed_object(vec![
            ("pt-x".into(), json!(1)),
            ("10".into(), json!(2)),
            ("2".into(), json!(3)),
        ]);
        assert_eq!(
            serde_json::to_string(&v).unwrap(),
            r#"{"2":3,"10":2,"pt-x":1}"#
        );
    }
}
