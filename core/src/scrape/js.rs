//! The JavaScript semantics the parser leans on, over `serde_json::Value`
//! (which is what `JSON.parse` hands the Node scraper). `Value` indexing
//! already behaves like optional chaining — a missing key, or any index
//! into a non-container, yields `Null` where JavaScript yields
//! `undefined` — so only truthiness, the `.length` read, `[0]`, `for…of`
//! and `String()` need spelling out. `String()` lives in `jsstr`.
use crate::{jsnum::js_number_spelling, jsstr::js_length};
use regex::Regex;
use serde_json::Value;

/// JavaScript `\s` without the `u` flag: WhiteSpace plus LineTerminator.
pub(crate) const WS: &str = r"[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
/// JavaScript `.` without the `s` flag: anything but a LineTerminator.
pub(super) const DOT: &str = r"[^\n\r\u{2028}\u{2029}]";

/// Compile a regex written in JavaScript's dialect: `\s` and `[\s\S]` take
/// their JavaScript meanings. Write `.` as [`DOT`] and `\b` as `(?-u:\b)`
/// (ASCII, as JavaScript's is) at the call site — neither is rewritten.
pub(crate) fn js_regex(source: &str) -> Regex {
    debug_assert!(
        !source.contains(r"\."),
        "spell an escaped dot outside js_regex"
    );
    Regex::new(&source.replace(r"[\s\S]", "(?s:.)").replace(r"\s", WS))
        .expect("static JavaScript regex")
}

/// `!!v`.
pub(crate) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `!!v?.length`: arrays and strings have one, an object has whatever it
/// says, and nothing else has one at all.
pub(super) fn has_length(v: &Value) -> bool {
    match v {
        Value::Array(a) => !a.is_empty(),
        Value::String(s) => js_length(s) > 0,
        Value::Object(o) => o.get("length").is_some_and(truthy),
        _ => false,
    }
}

/// `v?.[i]`: an array element, an object's `"i"` key, or a string's
/// character.
pub(super) fn at(v: &Value, i: usize) -> Value {
    match v {
        Value::Array(a) => a.get(i).cloned().unwrap_or(Value::Null),
        Value::Object(o) => o.get(&i.to_string()).cloned().unwrap_or(Value::Null),
        Value::String(s) => s
            .chars()
            .nth(i)
            .map(|c| Value::String(c.to_string()))
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// What `for (… of v)` walks: array elements, or a string's characters as
/// one-character strings. Anything else throws a `TypeError`; the caller
/// decides whether the Node source catches it.
pub(super) fn iterate(v: &Value) -> Result<Vec<Value>, NotIterable> {
    match v {
        Value::Array(a) => Ok(a.clone()),
        Value::String(s) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        other => Err(NotIterable(other.clone())),
    }
}

/// The `TypeError` from iterating a non-iterable, spelled as V8 spells it.
#[derive(Debug)]
pub(super) struct NotIterable(Value);

impl NotIterable {
    /// V8's message when the iterated expression is not a plain identifier
    /// (`item.categories ?? []`): the value's type, and for a primitive its
    /// spelling.
    pub(super) fn typed_message(&self) -> String {
        let kind = match &self.0 {
            Value::Number(n) => format!(
                "number {}",
                js_number_spelling(n.as_f64().unwrap_or(f64::NAN))
            ),
            Value::Bool(b) => format!("boolean {b}"),
            Value::Null => "null".to_string(),
            _ => "object".to_string(),
        };
        format!("{kind} is not iterable (cannot read property Symbol(Symbol.iterator))")
    }

    /// V8's message when the iterated expression is a plain identifier.
    pub(super) fn named_message(&self, name: &str) -> String {
        format!("{name} is not iterable")
    }
}

#[cfg(test)]
mod tests {
    use super::{at, has_length, iterate, truthy};
    use serde_json::json;

    #[test]
    fn javascript_truthiness_and_length() {
        assert!(!truthy(&json!(null)));
        assert!(!truthy(&json!(0)));
        assert!(!truthy(&json!("")));
        assert!(truthy(&json!([])));
        assert!(truthy(&json!({})));
        assert!(has_length(&json!("a")));
        assert!(!has_length(&json!([])));
        assert!(has_length(&json!({"length": "0"})));
        assert!(!has_length(&json!({"length": 0})));
        assert!(!has_length(&json!(5)));
    }

    #[test]
    fn index_and_iteration_follow_javascript() {
        assert_eq!(at(&json!("abc"), 0), json!("a"));
        assert_eq!(at(&json!({"0": 1}), 0), json!(1));
        assert_eq!(at(&json!(5), 0), json!(null));
        assert_eq!(iterate(&json!("ab")).unwrap(), vec![json!("a"), json!("b")]);
        // Every message is from node -e.
        assert_eq!(
            iterate(&json!(5)).unwrap_err().typed_message(),
            "number 5 is not iterable (cannot read property Symbol(Symbol.iterator))"
        );
        assert_eq!(
            iterate(&json!({})).unwrap_err().typed_message(),
            "object is not iterable (cannot read property Symbol(Symbol.iterator))"
        );
        assert_eq!(
            iterate(&json!(true)).unwrap_err().named_message("items"),
            "items is not iterable"
        );
    }
}
