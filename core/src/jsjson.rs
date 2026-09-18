//! `JSON.parse` as V8 reports its failures, and `JSON.stringify(JSON.parse(s))`.
//!
//! Sibling of `jsdate`, `jsnum` and `jsstr`. serde_json decides what a
//! valid document means; what it cannot do is fail in V8's words, and Node
//! stores those words: the policy store logs the History write's
//! `JSON.parse` failure in the run log, and the summariser (Phase 5,
//! batch 3) stores the message of a provider reply that is not JSON as the
//! analysis error the AI Policy tab shows.
//!
//! [`parse_error`] walks the source the way V8's `JsonParser` does
//! (`src/json/json-parser.cc`: the continuation loop of `ParseJsonValue`,
//! `ScanJsonString`, `ParseJsonNumber`, `ScanLiteral`) far enough to find
//! the first failure, and words it with the `kJsonParse*` templates from
//! `src/common/message-template.h`, attributed in `core/V8-LICENSE`. It
//! reports position, line and column in UTF-16 code units, as V8 counts,
//! and quotes up to ten units of context either side of the offending
//! character once the source is longer than twenty-one.
//!
//! Chosen divergences, none reachable from text a JavaScript writer
//! produced: where V8's quoted context or offending character would be one
//! half of a surrogate pair, this renders U+FFFD, since a Rust string
//! cannot hold the lone half; and a `\uD800`-style escape of a lone
//! surrogate, which V8 accepts and serde_json does not, is reported by
//! [`roundtrip`] in serde_json's words.
use crate::jsnum::js_number;
use crate::jsstr::js_object_key_order;
use serde_json::{Map, Value};

const MAX_CONTEXT: usize = 10;
/// `kMinOriginalSourceLengthForContext`: shorter sources are quoted whole.
const MIN_SOURCE_FOR_CONTEXT: usize = MAX_CONTEXT * 2 + 1;

const EXPECTED_PROPERTY_NAME_OR_RBRACE: &str = "Expected property name or '}' in JSON";
const EXPECTED_COMMA_OR_RBRACK: &str = "Expected ',' or ']' after array element in JSON";
const EXPECTED_COMMA_OR_RBRACE: &str = "Expected ',' or '}' after property value in JSON";
const EXPECTED_COLON: &str = "Expected ':' after property name in JSON";
const EXPECTED_DOUBLE_QUOTED_PROPERTY_NAME: &str = "Expected double-quoted property name in JSON";
const UNTERMINATED_STRING: &str = "Unterminated string in JSON";
const BAD_CONTROL_CHARACTER: &str = "Bad control character in string literal in JSON";
const BAD_UNICODE_ESCAPE: &str = "Bad Unicode escape in JSON";
const BAD_ESCAPED_CHARACTER: &str = "Bad escaped character in JSON";
const NO_NUMBER_AFTER_MINUS: &str = "No number after minus sign in JSON";
const UNTERMINATED_FRACTION: &str = "Unterminated fractional number in JSON";
const EXPONENT_MISSING_NUMBER: &str = "Exponent part is missing a number in JSON";
const NON_WHITESPACE_AFTER: &str = "Unexpected non-whitespace character after JSON";

/// `one_char_json_tokens`, plus end of input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    String,
    Number,
    LBrace,
    RBrace,
    LBrack,
    RBrack,
    Colon,
    Comma,
    True,
    False,
    Null,
    Whitespace,
    Illegal,
    Eos,
}

fn token_of(c: u16) -> Token {
    match c {
        0x22 => Token::String,
        0x2D | 0x30..=0x39 => Token::Number,
        0x7B => Token::LBrace,
        0x7D => Token::RBrace,
        0x5B => Token::LBrack,
        0x5D => Token::RBrack,
        0x3A => Token::Colon,
        0x2C => Token::Comma,
        0x74 => Token::True,
        0x66 => Token::False,
        0x6E => Token::Null,
        0x20 | 0x09 | 0x0A | 0x0D => Token::Whitespace,
        _ => Token::Illegal,
    }
}

fn is_digit(c: Option<u16>) -> bool {
    c.is_some_and(|c| (0x30..=0x39).contains(&c))
}

/// `IsNumberPart`: what may continue a number once it has started.
fn is_number_part(c: Option<u16>) -> bool {
    c.is_some_and(|c| (0x30..=0x39).contains(&c) || matches!(c, 0x2B | 0x2D | 0x2E | 0x45 | 0x65))
}

fn is_hex(c: Option<u16>) -> bool {
    c.is_some_and(|c| {
        (0x30..=0x39).contains(&c) || (0x41..=0x46).contains(&c) || (0x61..=0x66).contains(&c)
    })
}

fn lossy(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

enum Cont {
    Object,
    Array,
}

struct Parser<'a> {
    src: &'a [u16],
    pos: usize,
}

type Step = Result<(), String>;

impl Parser<'_> {
    fn cur(&self) -> Option<u16> {
        self.src.get(self.pos).copied()
    }
    fn peek(&self) -> Token {
        self.cur().map_or(Token::Eos, token_of)
    }
    fn skip_whitespace(&mut self) {
        while matches!(self.cur(), Some(0x20 | 0x09 | 0x0A | 0x0D)) {
            self.pos += 1;
        }
    }
    /// `Check`: whitespace, then the token if it is there.
    fn check(&mut self, token: Token) -> bool {
        self.skip_whitespace();
        if self.peek() == token {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    /// `Expect`: the token at the cursor, or the failure.
    fn expect(&mut self, token: Token, message: &'static str) -> Step {
        if self.peek() == token {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.report(self.peek(), Some(message)))
        }
    }
    /// `ExpectNext`: whitespace, then `Expect`.
    fn expect_next(&mut self, token: Token, message: &'static str) -> Step {
        self.skip_whitespace();
        self.expect(token, message)
    }

    /// `CalculateFileLocation`: `\r\n` is one line break, `\r` and `\n`
    /// one each; the column counts from one.
    fn location(&self) -> (usize, usize) {
        let mut line = 1;
        let mut last_break = 0;
        let mut i = 0;
        while i < self.pos {
            if self.src[i] == 0x0D && i + 1 < self.pos && self.src[i + 1] == 0x0A {
                i += 1;
            }
            if matches!(self.src[i], 0x0D | 0x0A) {
                line += 1;
                last_break = i + 1;
            }
            i += 1;
        }
        (line, 1 + self.pos - last_break)
    }

    /// `ReportUnexpectedToken`: an explicit template wins; otherwise the
    /// token picks one (`LookUpErrorMessageForJsonToken`).
    fn report(&self, token: Token, message: Option<&'static str>) -> String {
        let pos = self.pos;
        let (line, column) = self.location();
        let at = format!("at position {pos} (line {line} column {column})");
        if let Some(message) = message {
            return format!("{message} {at}");
        }
        match token {
            Token::Eos => "Unexpected end of JSON input".to_string(),
            Token::Number => format!("Unexpected number in JSON {at}"),
            Token::String => format!("Unexpected string in JSON {at}"),
            _ => {
                if is_special_string(self.src) {
                    return format!("\"{}\" is not valid JSON", lossy(self.src));
                }
                let ch = lossy(&self.src[pos..pos + 1]);
                let len = self.src.len();
                if len <= MIN_SOURCE_FOR_CONTEXT {
                    format!(
                        "Unexpected token '{ch}', \"{}\" is not valid JSON",
                        lossy(self.src)
                    )
                } else if pos < MAX_CONTEXT {
                    format!(
                        "Unexpected token '{ch}', \"{}\"... is not valid JSON",
                        lossy(&self.src[..pos + MAX_CONTEXT])
                    )
                } else if pos < len - MAX_CONTEXT {
                    format!(
                        "Unexpected token '{ch}', ...\"{}\"... is not valid JSON",
                        lossy(&self.src[pos - MAX_CONTEXT..pos + MAX_CONTEXT])
                    )
                } else {
                    format!(
                        "Unexpected token '{ch}', ...\"{}\" is not valid JSON",
                        lossy(&self.src[pos - MAX_CONTEXT..])
                    )
                }
            }
        }
    }

    /// `ReportUnexpectedCharacter`: the character's own token, anything
    /// past Latin-1 being illegal.
    fn unexpected_character(&self) -> String {
        let token = match self.cur() {
            None => Token::Eos,
            Some(c) if c <= 0xFF => token_of(c),
            Some(_) => Token::Illegal,
        };
        self.report(token, None)
    }

    /// `ScanJsonString`, the opening quote already consumed.
    fn scan_string(&mut self) -> Step {
        loop {
            let Some(c) = self.cur() else {
                return Err(self.report(Token::Illegal, Some(UNTERMINATED_STRING)));
            };
            if c == 0x22 {
                self.pos += 1;
                return Ok(());
            }
            if c == 0x5C {
                self.pos += 1;
                match self.cur() {
                    Some(e) if e > 0xFF => return Err(self.unexpected_character()),
                    None => return Err(self.unexpected_character()),
                    Some(0x22 | 0x5C | 0x2F | 0x62 | 0x66 | 0x6E | 0x72 | 0x74) => {}
                    Some(0x75) => {
                        for _ in 0..4 {
                            self.pos += 1;
                            if !is_hex(self.cur()) {
                                return Err(self.report(Token::Illegal, Some(BAD_UNICODE_ESCAPE)));
                            }
                        }
                    }
                    Some(_) => return Err(self.report(Token::Illegal, Some(BAD_ESCAPED_CHARACTER))),
                }
                self.pos += 1;
                continue;
            }
            if c < 0x20 {
                return Err(self.report(Token::Illegal, Some(BAD_CONTROL_CHARACTER)));
            }
            self.pos += 1;
        }
    }

    /// `ParseJsonNumber`, the cursor on its `-` or first digit.
    fn scan_number(&mut self) -> Step {
        let mut negative = false;
        if self.cur() == Some(0x2D) {
            negative = true;
            self.pos += 1;
        }
        if self.cur() == Some(0x30) {
            self.pos += 1;
            if is_number_part(self.cur()) {
                if is_digit(self.cur()) {
                    return Err(self.report(Token::Number, None));
                }
            } else if !negative {
                return Ok(());
            }
        } else {
            let start = self.pos;
            while is_digit(self.cur()) {
                self.pos += 1;
            }
            if self.pos == start {
                return Err(self.report(Token::Illegal, Some(NO_NUMBER_AFTER_MINUS)));
            }
        }
        if self.cur() == Some(0x2E) {
            self.pos += 1;
            if !is_digit(self.cur()) {
                return Err(self.report(Token::Illegal, Some(UNTERMINATED_FRACTION)));
            }
            while is_digit(self.cur()) {
                self.pos += 1;
            }
        }
        if matches!(self.cur(), Some(0x45 | 0x65)) {
            self.pos += 1;
            if matches!(self.cur(), Some(0x2B | 0x2D)) {
                self.pos += 1;
            }
            if !is_digit(self.cur()) {
                return Err(self.report(Token::Illegal, Some(EXPONENT_MISSING_NUMBER)));
            }
            while is_digit(self.cur()) {
                self.pos += 1;
            }
        }
        Ok(())
    }

    /// `ScanLiteral`, the cursor on its first character.
    fn scan_literal(&mut self, literal: &str) -> Step {
        let lit: Vec<u16> = literal.encode_utf16().collect();
        let remaining = self.src.len() - self.pos;
        if remaining >= lit.len() && self.src[self.pos + 1..self.pos + lit.len()] == lit[1..] {
            self.pos += lit.len();
            return Ok(());
        }
        self.pos += 1;
        for expected in lit.iter().skip(1).take((lit.len() - 1).min(remaining - 1)) {
            if self.cur() != Some(*expected) {
                return Err(self.unexpected_character());
            }
            self.pos += 1;
        }
        Err(self.report(Token::Eos, None))
    }
}

/// `IsSpecialString`: the whole source is one of the four strings a
/// careless caller stringifies by mistake.
fn is_special_string(src: &[u16]) -> bool {
    ["[object Object]", "undefined", "Infinity", "NaN"]
        .iter()
        .any(|s| s.encode_utf16().eq(src.iter().copied()))
}

/// The message `JSON.parse(text)` throws, or `None` when V8 accepts it.
pub fn parse_error(text: &str) -> Option<String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut p = Parser {
        src: &units,
        pos: 0,
    };
    let mut stack: Vec<Cont> = Vec::new();
    let result: Step = (|| 'produce: loop {
        loop {
            p.skip_whitespace();
            match p.peek() {
                Token::String => {
                    p.pos += 1;
                    p.scan_string()?;
                    break;
                }
                Token::Number => {
                    p.scan_number()?;
                    break;
                }
                Token::LBrace => {
                    p.pos += 1;
                    if p.check(Token::RBrace) {
                        break;
                    }
                    stack.push(Cont::Object);
                    p.expect_next(Token::String, EXPECTED_PROPERTY_NAME_OR_RBRACE)?;
                    p.scan_string()?;
                    p.expect_next(Token::Colon, EXPECTED_COLON)?;
                }
                Token::LBrack => {
                    p.pos += 1;
                    if p.check(Token::RBrack) {
                        break;
                    }
                    stack.push(Cont::Array);
                }
                Token::True => {
                    p.scan_literal("true")?;
                    break;
                }
                Token::False => {
                    p.scan_literal("false")?;
                    break;
                }
                Token::Null => {
                    p.scan_literal("null")?;
                    break;
                }
                _ => return Err(p.unexpected_character()),
            }
        }
        loop {
            match stack.last() {
                None => {
                    p.skip_whitespace();
                    if p.cur().is_some() {
                        return Err(p.report(p.peek(), Some(NON_WHITESPACE_AFTER)));
                    }
                    return Ok(());
                }
                Some(Cont::Object) => {
                    if p.check(Token::Comma) {
                        p.expect_next(Token::String, EXPECTED_DOUBLE_QUOTED_PROPERTY_NAME)?;
                        p.scan_string()?;
                        p.expect_next(Token::Colon, EXPECTED_COLON)?;
                        continue 'produce;
                    }
                    p.expect(Token::RBrace, EXPECTED_COMMA_OR_RBRACE)?;
                    stack.pop();
                }
                Some(Cont::Array) => {
                    if p.check(Token::Comma) {
                        continue 'produce;
                    }
                    p.expect(Token::RBrack, EXPECTED_COMMA_OR_RBRACK)?;
                    stack.pop();
                }
            }
        }
    })();
    result.err()
}

/// `JSON.parse(text)`: V8's message when it throws, else the value with
/// JavaScript's numbers (every number a double) and key order (array-index
/// keys first, ascending).
pub fn parse(text: &str) -> Result<Value, String> {
    if let Some(message) = parse_error(text) {
        return Err(message);
    }
    serde_json::from_str::<Value>(text)
        .map(js_value)
        .map_err(|e| e.to_string())
}

/// `JSON.stringify(JSON.parse(text))`.
pub fn roundtrip(text: &str) -> Result<String, String> {
    parse(text).map(|v| v.to_string())
}

/// A parsed value as JavaScript holds it.
pub fn js_value(value: Value) -> Value {
    match value {
        Value::Number(n) => {
            if let Some(i) = n.as_i64().filter(|i| i.unsigned_abs() <= 1 << 53) {
                return Value::from(i);
            }
            js_number(n.as_f64().unwrap_or(f64::NAN))
        }
        Value::Array(items) => Value::Array(items.into_iter().map(js_value).collect()),
        Value::Object(map) => {
            let order: Vec<String> = js_object_key_order(map.keys().map(String::as_str))
                .into_iter()
                .map(str::to_string)
                .collect();
            let mut map = map;
            let mut out = Map::with_capacity(order.len());
            for key in order {
                if let Some(v) = map.remove(&key) {
                    out.insert(key, js_value(v));
                }
            }
            Value::Object(out)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The messages were read out of `node -e 'JSON.parse(...)'` (Node 26);
    /// the fixture replay in `server::policy_store_tests` holds the rest.
    #[test]
    fn messages_follow_v8() {
        assert_eq!(parse_error("[]"), None);
        assert_eq!(
            parse_error("").as_deref(),
            Some("Unexpected end of JSON input")
        );
        assert_eq!(
            parse_error("{not json").as_deref(),
            Some("Expected property name or '}' in JSON at position 1 (line 1 column 2)")
        );
        assert_eq!(
            parse_error("[1111111111111111, x, 2222222222222222]").as_deref(),
            Some("Unexpected token 'x', ...\"11111111, x, 2222222\"... is not valid JSON")
        );
        assert_eq!(
            parse_error("{\n\"a\": 1,\n\"b\" 2}").as_deref(),
            Some("Expected ':' after property name in JSON at position 14 (line 3 column 5)")
        );
    }

    #[test]
    fn values_take_javascript_numbers_and_key_order() {
        assert_eq!(roundtrip("-0").unwrap(), "0");
        assert_eq!(
            roundtrip("[1.50, 1e5, 12345678901234567890, 1152921504606846976]").unwrap(),
            "[1.5,100000,12345678901234567000,1152921504606847000]"
        );
        assert_eq!(
            roundtrip(r#"{"b":1,"2":2,"1":3}"#).unwrap(),
            r#"{"1":3,"2":2,"b":1}"#
        );
    }
}
