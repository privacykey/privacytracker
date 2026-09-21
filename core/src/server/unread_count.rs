//! The bell's unread count with a notification type switched off: the slow
//! path of `getUnreadCount` in lib/notifications.ts.
//!
//! With every type on, the count is one `COUNT(*)` (in `user_content`).
//! With any type off, which is every fresh install because
//! `flag.notifications.types.policy_updates` is off by default, Node walks
//! every unread row, `JSON.parse`s its `change_summary` and counts the rows
//! its type filter leaves something in. The port first did the same with
//! the list's helpers: a `Value` per row, renormalised to JavaScript's
//! numbers and key order, then a filtered copy of every entry, all to
//! answer yes or no. On the 5,000-app stress fleet (10,000 unread rows)
//! that was about 17 of the route's 21 ms; V8 parses the same rows in 3.
//!
//! So each row is read from SQLite's own buffer and streamed through
//! serde_json, keeping only what the filter reads: whether the row is
//! empty (`changes.length === 0`), and each entry's `type`, `category` and
//! `description`, reduced to the comparisons `classify` makes. No tree is
//! built and nothing is copied, beyond serde_json's scratch buffer for a
//! string with escapes in it.
//!
//! The answer is the one the full parse gave, input for input, but for the
//! two exceptions below. Every value still goes through `deserialize_any`,
//! which is what a `Value` asks for, so strings are unescaped and checked,
//! numbers are range-checked and the depth limit applies exactly as before,
//! and a row that does not parse still counts, as `[]`. (`IgnoredAny` would
//! be quicker, but it skips those checks and would count rows the parse
//! rejects.) A repeated key keeps its last value, as in `JSON.parse`.
//!
//! The two exceptions are deliberate, and both move toward Node. Read as a
//! `Value`, an object whose first key is serde_json's private `RawValue`
//! token is replaced by a parse of the string it holds, a quirk of the
//! `raw_value` feature axum turns on; here it is an ordinary object. And
//! text that is not valid UTF-8 is decoded with replacement characters, as
//! better-sqlite3 decodes it, where rusqlite's `Value` conversion panicked.
//! The tests hold the two paths to the same answer over hand-picked and
//! generated rows under every combination of the flags.

use super::{
    stats,
    user_content::{classify, DIFF_CHANGE_TYPES, FLAGGED_CATEGORIES, NEW_PRIVACY_TYPE_PREFIX},
};
use rusqlite::{types::ValueRef, Connection};
use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use std::{borrow::Cow, fmt};

/// How many unread, due rows the type filter leaves something in, counting
/// every row with nothing to filter: an empty change list, or JSON that
/// does not parse, which only this count forgives.
pub(super) fn filtered(conn: &Connection, now: i64, enabled: &[bool; 4]) -> stats::Result<u64> {
    let mut stmt = conn.prepare(
        "SELECT change_summary FROM notifications WHERE read=0 AND (not_before IS NULL OR not_before <= ?)",
    )?;
    let mut rows = stmt.query([now])?;
    let mut count = 0;
    while let Some(row) = rows.next()? {
        // Borrowed, not copied. Invalid UTF-8 is replaced, as better-sqlite3
        // replaces it and as `row::column_value` decodes a BLOB; anything
        // else reads as "", which does not parse, as `text` read it before.
        let raw = match row.get_ref(0)? {
            ValueRef::Text(b) | ValueRef::Blob(b) => String::from_utf8_lossy(b),
            _ => Cow::Borrowed(""),
        };
        if counts(&raw, enabled)? {
            count += 1;
        }
    }
    Ok(count)
}

/// Whether one row counts. The errors are the route's 500: Node's
/// `applyTypeFilter` throws on a row that parses to anything but a list or
/// a value whose `length` is 0, and `classifyChange` on a `null` entry.
pub(super) fn counts(raw: &str, enabled: &[bool; 4]) -> stats::Result<bool> {
    let mut de = serde_json::Deserializer::from_str(raw);
    let parsed = Ask(Row(enabled))
        .deserialize(&mut de)
        .and_then(|shape| de.end().map(|()| shape));
    match parsed {
        // `JSON.parse` threw, and the count reads the row as `[]`.
        Err(_) | Ok(Shape::Empty) => Ok(true),
        Ok(Shape::Entries { null: true, .. }) => Err("null notification change".into()),
        Ok(Shape::Entries { kept, .. }) => Ok(kept),
        Ok(Shape::Other) => Err("change_summary must be an array".into()),
    }
}

/// A row's `change_summary`, as far as the count is concerned.
enum Shape {
    /// `changes.length === 0`: `[]`, `""`, or an object whose `length` is 0.
    Empty,
    /// A list with entries: whether the filter keeps any, and whether any
    /// is `null`.
    Entries { kept: bool, null: bool },
    /// Anything else.
    Other,
}

/// One question put to a JSON value while serde_json parses it. The value
/// is parsed whole whatever the question: a method a probe does not
/// override walks what it is given with `Skip` and answers `other`.
trait Probe: Sized {
    type Answer;
    fn other(self) -> Self::Answer;
    fn null(self) -> Self::Answer {
        self.other()
    }
    fn number(self, _: f64) -> Self::Answer {
        self.other()
    }
    fn string(self, _: &str) -> Self::Answer {
        self.other()
    }
    fn list<'de, A: SeqAccess<'de>>(self, mut items: A) -> Result<Self::Answer, A::Error> {
        while items.next_element_seed(Ask(Skip))?.is_some() {}
        Ok(self.other())
    }
    fn object<'de, A: MapAccess<'de>>(self, mut fields: A) -> Result<Self::Answer, A::Error> {
        while fields.next_key_seed(Ask(Skip))?.is_some() {
            fields.next_value_seed(Ask(Skip))?;
        }
        Ok(self.other())
    }
}

/// A probe as serde's seed and visitor, always through `deserialize_any`.
struct Ask<P>(P);

impl<'de, P: Probe> DeserializeSeed<'de> for Ask<P> {
    type Value = P::Answer;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<P::Answer, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de, P: Probe> Visitor<'de> for Ask<P> {
    type Value = P::Answer;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_unit<E: de::Error>(self) -> Result<P::Answer, E> {
        Ok(self.0.null())
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<P::Answer, E> {
        Ok(self.0.other())
    }
    fn visit_i64<E: de::Error>(self, n: i64) -> Result<P::Answer, E> {
        Ok(self.0.number(n as f64))
    }
    fn visit_u64<E: de::Error>(self, n: u64) -> Result<P::Answer, E> {
        Ok(self.0.number(n as f64))
    }
    fn visit_f64<E: de::Error>(self, n: f64) -> Result<P::Answer, E> {
        Ok(self.0.number(n))
    }
    fn visit_str<E: de::Error>(self, s: &str) -> Result<P::Answer, E> {
        Ok(self.0.string(s))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, items: A) -> Result<P::Answer, A::Error> {
        self.0.list(items)
    }
    fn visit_map<A: MapAccess<'de>>(self, fields: A) -> Result<P::Answer, A::Error> {
        self.0.object(fields)
    }
}

/// Any value, dropped once parsed.
struct Skip;
impl Probe for Skip {
    type Answer = ();
    fn other(self) {}
}

/// Which of these strings the value is, if it is one of them.
#[derive(Clone, Copy)]
struct OneOf(&'static [&'static str]);
impl Probe for OneOf {
    type Answer = Option<&'static str>;
    fn other(self) -> Option<&'static str> {
        None
    }
    fn string(self, s: &str) -> Option<&'static str> {
        self.0.iter().copied().find(|choice| *choice == s)
    }
}

/// Whether the value is a string starting with `NEW_PRIVACY_TYPE_PREFIX`.
struct NewTypeDescription;
impl Probe for NewTypeDescription {
    type Answer = bool;
    fn other(self) -> bool {
        false
    }
    fn string(self, s: &str) -> bool {
        s.starts_with(NEW_PRIVACY_TYPE_PREFIX)
    }
}

/// Whether the value is a number `=== 0`, which -0 is too.
struct Zero;
impl Probe for Zero {
    type Answer = bool;
    fn other(self) -> bool {
        false
    }
    fn number(self, n: f64) -> bool {
        n == 0.0
    }
}

/// One entry of a change list: `None` for `null`, otherwise whether the
/// type filter keeps it.
struct Entry<'a>(&'a [bool; 4]);
impl Probe for Entry<'_> {
    type Answer = Option<bool>;
    /// Not an object, so it has no `type`, and no flag governs it.
    fn other(self) -> Option<bool> {
        Some(true)
    }
    fn null(self) -> Option<bool> {
        None
    }
    fn object<'de, A: MapAccess<'de>>(self, mut fields: A) -> Result<Option<bool>, A::Error> {
        let (mut kind, mut category, mut new_type) = (None, None, false);
        let names = OneOf(&["type", "category", "description"]);
        while let Some(name) = fields.next_key_seed(Ask(names))? {
            match name {
                Some("type") => kind = fields.next_value_seed(Ask(OneOf(&DIFF_CHANGE_TYPES)))?,
                Some("category") => {
                    category = fields.next_value_seed(Ask(OneOf(&FLAGGED_CATEGORIES)))?;
                }
                Some("description") => {
                    new_type = fields.next_value_seed(Ask(NewTypeDescription))?
                }
                _ => fields.next_value_seed(Ask(Skip))?,
            }
        }
        Ok(Some(
            classify(kind, category, new_type).is_none_or(|i| self.0[i]),
        ))
    }
}

/// A whole `change_summary`.
struct Row<'a>(&'a [bool; 4]);
impl Probe for Row<'_> {
    type Answer = Shape;
    fn other(self) -> Shape {
        Shape::Other
    }
    fn string(self, s: &str) -> Shape {
        if s.is_empty() {
            Shape::Empty
        } else {
            Shape::Other
        }
    }
    fn list<'de, A: SeqAccess<'de>>(self, mut entries: A) -> Result<Shape, A::Error> {
        let (mut any, mut kept, mut null) = (false, false, false);
        while let Some(entry) = entries.next_element_seed(Ask(Entry(self.0)))? {
            any = true;
            kept |= entry == Some(true);
            null |= entry.is_none();
        }
        Ok(if any {
            Shape::Entries { kept, null }
        } else {
            Shape::Empty
        })
    }
    fn object<'de, A: MapAccess<'de>>(self, mut fields: A) -> Result<Shape, A::Error> {
        let mut zero = false;
        while let Some(name) = fields.next_key_seed(Ask(OneOf(&["length"])))? {
            if name.is_some() {
                zero = fields.next_value_seed(Ask(Zero))?;
            } else {
                fields.next_value_seed(Ask(Skip))?;
            }
        }
        Ok(if zero { Shape::Empty } else { Shape::Other })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::user_content::{empty_length, filter_changes, parse};
    use serde_json::json;

    /// All sixteen combinations of the four type flags.
    fn every_filter() -> impl Iterator<Item = [bool; 4]> {
        (0u8..16).map(|m| std::array::from_fn(|i| (m >> i) & 1 == 1))
    }

    /// Holds the stream to what the count answered before it streamed: the
    /// whole row parsed (as `[]` when it does not parse) and filtered, and
    /// kept if anything is left.
    fn agree(raw: &str) {
        let parsed = parse(raw).unwrap_or(json!([]));
        for enabled in every_filter() {
            let before = filter_changes(&parsed, &enabled)
                .map(|f| empty_length(&parsed) || f.as_array().is_some_and(|a| !a.is_empty()))
                .map_err(|e| e.to_string());
            let now = counts(raw, &enabled).map_err(|e| e.to_string());
            assert_eq!(now, before, "{raw:?} under {enabled:?}");
        }
    }

    #[test]
    fn hand_picked_rows_count_as_the_full_parse_counted_them() {
        let rows = [
            // What the writers store, one per classify branch, plus the
            // stress seed's entry (no `type`) and a system notice.
            "[]",
            r#"[{"type":"policy","category":"privacy-policy","description":"Privacy policy has been updated.","details":[]}]"#,
            r#"[{"type":"added","category":"accessibility","description":"Now supports accessibility feature: \"VoiceOver\""}]"#,
            r#"[{"type":"added","description":"New privacy label: \"Data Used to Track You\"","details":["Contacts"]}]"#,
            r#"[{"type":"added","description":"\"Data Linked to You\" now collects: Contacts"}]"#,
            r#"[{"type":"removed","description":"x"},{"type":"wayback","category":"privacy-policy"}]"#,
            r#"[{"category":"privacy-label","description":"Added \"Location\" to Data Used to Track You","details":["Location"]}]"#,
            r#"[{"type":"ai_timeout","description":"ai_timeout notice"}]"#,
            // The content oracle's malformed shapes.
            "broken",
            "null",
            "{}",
            r#""""#,
            r#"{"length":0}"#,
            "[null]",
            r#"[{},0,false,{"type":"added","details":{"length":0}}]"#,
            // Empty as `.length === 0` sees it, and not.
            "",
            " ",
            r#""x""#,
            "0",
            "-0",
            "true",
            r#"{"length":0.0}"#,
            r#"{"length":-0}"#,
            r#"{"length":-0.0e5}"#,
            r#"{"length":1e-400}"#,
            r#"{"length":1}"#,
            r#"{"length":"0"}"#,
            r#"{"length":false}"#,
            r#"{"length":null}"#,
            r#"{"length":[]}"#,
            r#"{"length":1,"length":0}"#,
            r#"{"length":0,"length":1}"#,
            r#"{"lengt\u0068":0}"#,
            r#"{"x":{"length":0},"length":0,"y":[null]}"#,
            // Entries the filter cannot classify, and a null anywhere.
            r#"[{"type":"added"},null]"#,
            r#"[null,{"type":"added"}]"#,
            r#"[[],"",1,true]"#,
            r#"[{"type":null},{"type":["added"]},{"type":{"type":"added"}}]"#,
            r#"[{"type":"added","category":null,"description":7}]"#,
            // A repeated key keeps its last value.
            r#"[{"type":"added","type":"ai_timeout"}]"#,
            r#"[{"type":"ai_timeout","type":"added"}]"#,
            r#"[{"type":"added","category":"privacy-policy","category":"x"}]"#,
            r#"[{"type":"added","description":"New privacy label: a","description":"b"}]"#,
            r#"[{"type":"added","description":"b","description":"New privacy label: a"}]"#,
            // Keys and values are compared unescaped.
            r#"[{"typ\u0065":"\u0061dded","category":"privacy\u002dpolicy"}]"#,
            r#"[{"type":"added","description":"New privacy label:\u0020x"}]"#,
            r#"[{"type":"added","description":"New privacy label: \ud83d\ude00"}]"#,
            // What a `Value` refuses, the stream refuses, wherever it is.
            // Each sits beside an entry the filter can drop, or in a shape
            // that fails the route, so a laxer parse would change the answer.
            r#"[{"type":"added","x":"\ud800"}]"#,
            r#"[{"type":"added","x":["\udc00"]}]"#,
            r#"[{"type":"added","\ud800":1}]"#,
            r#"[{"type":"added","x":1e400}]"#,
            r#"[{"type":"added"},-1e400]"#,
            r#"[{"type":"added","x":"\q"}]"#,
            "[{\"type\":\"added\",\"x\":\"a\nb\"}]",
            r#"{"x":"\ud800"}"#,
            r#"[null,"\ud800"]"#,
            r#"[{"type":"added"},]"#,
            r#"[{"type":"added","a":1,}]"#,
            r#"[{"type":"added","a" 1}]"#,
            r#"[{"type":"added"}"#,
            r#"[{"type":"added"}] x"#,
            r#"[{"type":"added"}]]"#,
            "null x",
            "\u{feff}[{\"type\":\"added\"}]",
            r#"[{"type":"added"},NaN]"#,
            r#"[{"type":"added"},Infinity]"#,
            r#"[{"type":"added"},'a']"#,
            r#"[{"type":"added"},01]"#,
            r#"[{"type":"added"},1.]"#,
            r#"[{"type":"added"},.5]"#,
            r#"[{"type":"added"},+1]"#,
            r#"/* c */ [{"type":"added"}]"#,
            "\u{a0}[{\"type\":\"added\"}]",
            " \t\n\r[{\"type\":\"added\"}] \n",
            // Numbers `Value` keeps as it read them.
            r#"[{"type":"added","n":12345678901234567890,"m":-9223372036854775809}]"#,
            r#"[{"type":"added","n":1.0,"m":-0.0,"o":1E2}]"#,
        ];
        for raw in rows {
            agree(raw);
        }
    }

    #[test]
    fn nesting_fails_at_the_same_depth() {
        for depth in [126, 127, 128, 129, 300] {
            let nest = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
            agree(&nest);
            agree(&format!(r#"[{{"type":"added","x":{nest}}}]"#));
            agree(&format!(r#"{{"length":0,"x":{nest}}}"#));
        }
    }

    /// splitmix64, so the corpus is the same on every run.
    struct Rng(u64);
    impl Rng {
        fn below(&mut self, n: usize) -> usize {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            ((z ^ (z >> 31)) % n as u64) as usize
        }
        fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
            items[self.below(items.len())]
        }
    }

    const NAMES: &[&str] = &[
        "type",
        "category",
        "description",
        "length",
        "details",
        "typ\\u0065",
        "x",
    ];
    const STRINGS: &[&str] = &[
        "added",
        "removed",
        "modified",
        "policy",
        "wayback",
        "changed",
        "ai_timeout",
        "privacy-policy",
        "accessibility",
        "privacy-label",
        "New privacy label: X",
        "New privacy label:",
        "\\u0061dded",
        "",
        "Added \\\"x\\\"",
        "\\ud800",
        "\\ud83d\\ude00",
    ];
    const NUMBERS: &[&str] = &["0", "0.0", "-0", "1", "-1", "2.5", "1e400", "1e-400"];

    fn value(rng: &mut Rng, depth: u32, out: &mut String) {
        match rng.below(if depth > 2 { 6 } else { 9 }) {
            0 => out.push_str("null"),
            1 => out.push_str(rng.pick(&["true", "false"])),
            2 => out.push_str(rng.pick(NUMBERS)),
            3..=5 => {
                out.push('"');
                out.push_str(rng.pick(STRINGS));
                out.push('"');
            }
            6 | 7 => {
                out.push('[');
                for i in 0..rng.below(4) {
                    if i > 0 {
                        out.push(',');
                    }
                    value(rng, depth + 1, out);
                }
                out.push(']');
            }
            _ => object(rng, depth, out),
        }
    }

    fn object(rng: &mut Rng, depth: u32, out: &mut String) {
        out.push('{');
        for i in 0..rng.below(5) {
            if i > 0 {
                out.push(',');
            }
            out.push('"');
            out.push_str(rng.pick(NAMES));
            out.push_str("\":");
            value(rng, depth + 1, out);
        }
        out.push('}');
    }

    /// Mostly change lists of entry-shaped objects, then about one in three
    /// damaged a character at a time.
    fn row(rng: &mut Rng) -> String {
        let mut out = String::new();
        if rng.below(10) < 7 {
            out.push('[');
            for i in 0..rng.below(4) {
                if i > 0 {
                    out.push(',');
                }
                if rng.below(5) < 4 {
                    object(rng, 1, &mut out);
                } else {
                    value(rng, 1, &mut out);
                }
            }
            out.push(']');
        } else {
            value(rng, 0, &mut out);
        }
        if rng.below(3) == 0 {
            let mut chars: Vec<char> = out.chars().collect();
            for _ in 0..=rng.below(3) {
                let at = rng.below(chars.len() + 1);
                let c = rng.pick(&["[", "]", "{", "}", ",", ":", "\"", "\\", " ", "0", "e", "n"]);
                match rng.below(3) {
                    0 if at < chars.len() => {
                        chars.remove(at);
                    }
                    1 if at < chars.len() => chars[at] = c.chars().next().unwrap(),
                    _ => chars.insert(at, c.chars().next().unwrap()),
                }
            }
            out = chars.into_iter().collect();
        }
        out
    }

    #[test]
    fn generated_rows_count_as_the_full_parse_counted_them() {
        let mut rng = Rng(20_260_921);
        let (mut parsed, mut failed) = (0, 0);
        for _ in 0..4_000 {
            let raw = row(&mut rng);
            agree(&raw);
            match parse(&raw) {
                Ok(_) => parsed += 1,
                Err(_) => failed += 1,
            }
        }
        // Enough of each that the corpus tests both halves.
        assert!(
            parsed > 1_000 && failed > 500,
            "{parsed} parsed, {failed} failed"
        );
    }

    #[test]
    fn the_raw_value_token_is_an_ordinary_key_as_in_node() {
        let off = [false; 4];
        // A `Value` reads this as the `[]` in the string; Node sees an
        // object with no `filter` to call, and so does the stream.
        let raw = r#"{"$serde_json::private::RawValue":"[]"}"#;
        assert_eq!(parse(raw).unwrap(), json!([]));
        assert!(counts(raw, &off).is_err());
        // Not a string `type`, so no flag governs the entry and it stays.
        let entry = r#"[{"type":{"$serde_json::private::RawValue":"\"added\""}}]"#;
        assert_eq!(parse(entry).unwrap()[0]["type"], "added");
        assert!(counts(entry, &off).unwrap());
    }

    #[test]
    fn the_walk_counts_due_unread_rows_of_any_storage_class() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema_sql::SCHEMA_SQL).unwrap();
        let now = 1_000_000;
        let insert = |id: &str, summary: &str, read: i64, not_before: Option<i64>| {
            conn.execute(
                "INSERT INTO notifications (id,app_name,change_summary,created_at,read,not_before) VALUES (?,'App',?,0,?,?)",
                rusqlite::params![id, summary, read, not_before],
            )
            .unwrap();
        };
        let policy = r#"[{"type":"policy","category":"privacy-policy"}]"#;
        insert("empty", "[]", 0, None);
        insert("corrupt", "broken", 0, Some(now));
        insert("policy", policy, 0, None);
        insert("label", r#"[{"type":"added"}]"#, 0, None);
        insert("read", "[]", 1, None);
        insert("deferred", "[]", 0, Some(now + 1));
        // A BLOB and invalid UTF-8 read as text, with the bad byte replaced
        // (`["\u{FFFD}"]`, an entry with no type, so it stays). The list's
        // `Value` conversion panics on the latter; Node counts it.
        conn.execute_batch(
            r#"INSERT INTO notifications (id,app_name,change_summary,created_at) VALUES
                 ('blob','App',CAST('[{"type":"added"}]' AS BLOB),0),
                 ('invalid','App',CAST(X'5B22FF225D' AS TEXT),0);"#,
        )
        .unwrap();
        assert_eq!(filtered(&conn, now, &[true, false, true, true]).unwrap(), 5);
        assert_eq!(filtered(&conn, now, &[false, true, true, true]).unwrap(), 4);
        assert_eq!(filtered(&conn, now, &[false; 4]).unwrap(), 3);
        insert("null-entry", "[null]", 0, None);
        assert!(filtered(&conn, now, &[false; 4]).is_err());
    }
}
