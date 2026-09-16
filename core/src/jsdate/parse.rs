//! `Date.parse` / `new Date(string)` as V8 implements it: the ISO format
//! first, then the legacy free-form rules (month names, am/pm, the US zone
//! abbreviations, parenthesised comments), with local-time inputs resolved
//! through the process timezone exactly as Node resolves them.
//!
//! Phase 2 needs it for backup filenames and the CSV export; Node also
//! parses date strings in the scraper, the Wayback importer and the stats
//! views, which later phases port — hence crate level, beside `jsnum` and
//! `jsstr`, rather than a route helper.
//!
//! Scanner/composition rules adapted from V8 src/date/dateparser{,-inl}.{h,cc}.
//! Copyright 2011 the V8 project authors. BSD license: ../../V8-LICENSE.
use crate::jsstr::is_js_whitespace;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Token {
    Num(i64, usize),
    Sym(char),
    Month(i64),
    Zone(i64),
    AmPm(i64),
    Time,
    Word,
    White,
    Unknown,
    End,
}
struct Scanner {
    tokens: Vec<Token>,
    at: usize,
}
impl Scanner {
    fn new(raw: &str) -> Self {
        let chars: Vec<char> = raw.chars().take_while(|c| *c != '\0').collect();
        let mut tokens = Vec::new();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c.is_ascii_digit() {
                let start = i;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                let digits: String = chars[start..i].iter().collect();
                let significant: String = digits.trim_start_matches('0').chars().take(9).collect();
                tokens.push(Token::Num(significant.parse().unwrap_or(0), i - start));
                continue;
            }
            if ":-+.)".contains(c) {
                tokens.push(Token::Sym(c));
            } else if c >= 'A' && !is_js_whitespace(c) {
                let start = i;
                while i < chars.len() && chars[i] >= 'A' && !is_js_whitespace(chars[i]) {
                    i += 1;
                }
                let word: String = chars[start..i]
                    .iter()
                    .map(|c| c.to_ascii_lowercase())
                    .collect();
                let months = [
                    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov",
                    "dec",
                ];
                tokens.push(
                    if let Some(m) = months.iter().position(|m| word.starts_with(m)) {
                        Token::Month(m as i64 + 1)
                    } else {
                        match word.as_str() {
                            "am" => Token::AmPm(0),
                            "pm" => Token::AmPm(12),
                            "ut" | "utc" | "gmt" | "z" => Token::Zone(0),
                            "cdt" | "est" => Token::Zone(-5),
                            "cst" | "mdt" => Token::Zone(-6),
                            "edt" => Token::Zone(-4),
                            "mst" | "pdt" => Token::Zone(-7),
                            "pst" => Token::Zone(-8),
                            "t" => Token::Time,
                            _ => Token::Word,
                        }
                    },
                );
                // ISO only accepts the single-letter Z timezone token.
                if word == "z" {
                    *tokens.last_mut().unwrap() = Token::Sym('Z');
                }
                continue;
            } else if is_js_whitespace(c) {
                tokens.push(Token::White);
            } else if c == '(' {
                let mut depth = 1;
                i += 1;
                while i < chars.len() && depth > 0 {
                    if chars[i] == '(' {
                        depth += 1;
                    } else if chars[i] == ')' {
                        depth -= 1;
                    }
                    i += 1;
                }
                tokens.push(Token::Unknown);
                continue;
            } else {
                tokens.push(Token::Unknown);
            }
            i += 1;
        }
        tokens.push(Token::End);
        Self { tokens, at: 0 }
    }
    fn peek(&self) -> Token {
        *self.tokens.get(self.at).unwrap_or(&Token::End)
    }
    fn next(&mut self) -> Token {
        let t = self.peek();
        self.at += 1;
        t
    }
    fn skip(&mut self, c: char) -> bool {
        if self.peek() == Token::Sym(c) {
            self.next();
            true
        } else {
            false
        }
    }
    fn fixed(&mut self, len: usize, max: i64) -> Option<i64> {
        match self.next() {
            Token::Num(n, l) if l == len && n <= max => Some(n),
            _ => None,
        }
    }
}
#[derive(Default)]
struct Parts {
    day: Vec<i64>,
    time: Vec<i64>,
    month: Option<i64>,
    am_pm: Option<i64>,
    sign: i64,
    zone_hour: Option<i64>,
    zone_minute: Option<i64>,
    iso: bool,
}
impl Parts {
    fn zone(&mut self, h: i64) {
        self.sign = if h < 0 { -1 } else { 1 };
        self.zone_hour = Some(h.abs());
        self.zone_minute = Some(0);
    }
    fn expects_time(&self, n: i64) -> bool {
        match self.time.len() {
            1 | 2 => (0..=59).contains(&n),
            3 => (0..=999).contains(&n),
            _ => false,
        }
    }
    fn add_time(&mut self, n: i64) -> Option<()> {
        if self.time.len() >= 4 {
            None
        } else {
            self.time.push(n);
            Some(())
        }
    }
    fn final_time(&mut self, n: i64) -> Option<()> {
        self.add_time(n)?;
        self.time.resize(4, 0);
        Some(())
    }
}
fn milliseconds(n: i64, len: usize) -> i64 {
    if len < 3 {
        n * 10i64.pow((3 - len) as u32)
    } else {
        n / 10i64.pow((len.min(9) - 3) as u32)
    }
}
fn iso(s: &mut Scanner, p: &mut Parts) -> Option<Token> {
    match s.peek() {
        Token::Sym(sign @ ('+' | '-')) => {
            let token = s.next();
            if !matches!(s.peek(), Token::Num(_, 6)) {
                return Some(token);
            }
            let year = s.fixed(6, 999999)?;
            if sign == '-' && year == 0 {
                return Some(token);
            }
            p.day.push(if sign == '-' { -year } else { year });
        }
        Token::Num(_, 4) => p.day.push(s.fixed(4, 9999)?),
        _ => return Some(s.next()),
    }
    if s.skip('-') {
        if !matches!(s.peek(), Token::Num(1..=12, 2)) {
            return Some(s.next());
        }
        p.day.push(s.fixed(2, 12)?);
        if s.skip('-') {
            if !matches!(s.peek(), Token::Num(1..=31, 2)) {
                return Some(s.next());
            }
            p.day.push(s.fixed(2, 31)?);
        }
    }
    if s.peek() == Token::Time {
        s.next();
        let h = s.fixed(2, 24)?;
        p.time.push(h);
        if !s.skip(':') {
            return None;
        }
        let m = s.fixed(2, if h == 24 { 0 } else { 59 })?;
        p.time.push(m);
        if s.skip(':') {
            p.time.push(s.fixed(2, if h == 24 { 0 } else { 59 })?);
            if s.skip('.') {
                let Token::Num(n, l) = s.next() else {
                    return None;
                };
                if h == 24 && n > 0 {
                    return None;
                }
                p.time.push(milliseconds(n, l));
            }
        }
        if s.skip('Z') {
            p.zone(0);
        } else if matches!(s.peek(), Token::Sym('+' | '-')) {
            p.sign = if s.next() == Token::Sym('-') { -1 } else { 1 };
            let (h, m) = if matches!(s.peek(), Token::Num(_, 4)) {
                let n = s.fixed(4, 2359)?;
                (n / 100, n % 100)
            } else {
                let h = s.fixed(2, 23)?;
                if !s.skip(':') {
                    return None;
                }
                (h, s.fixed(2, 59)?)
            };
            if m > 59 {
                return None;
            }
            p.zone_hour = Some(h);
            p.zone_minute = Some(m);
        }
        if s.peek() != Token::End {
            return None;
        }
    } else if s.peek() != Token::End {
        return Some(s.next());
    }
    if p.zone_hour.is_none() && p.time.is_empty() {
        p.zone(0);
    }
    p.iso = true;
    Some(Token::End)
}

/// `Date.parse(raw)`: epoch milliseconds, or `None` where JavaScript yields `NaN`.
pub fn parse(raw: &str) -> Option<i64> {
    let mut s = Scanner::new(raw);
    let mut p = Parts::default();
    let mut token = iso(&mut s, &mut p)?;
    let mut number_seen = !p.day.is_empty();
    while token != Token::End {
        match token {
            Token::Num(n, _) => {
                number_seen = true;
                if s.skip(':') {
                    if s.skip(':') {
                        if !p.time.is_empty() {
                            return None;
                        }
                        p.add_time(n)?;
                        p.add_time(0)?;
                    } else {
                        p.add_time(n)?;
                        s.skip('.');
                    }
                } else if s.skip('.') && p.expects_time(n) {
                    p.add_time(n)?;
                    let Token::Num(ms, l) = s.next() else {
                        return None;
                    };
                    p.final_time(milliseconds(ms, l))?;
                } else if p.zone_hour.is_some() && p.zone_minute.is_none() && n <= 59 {
                    p.zone_minute = Some(n);
                } else if p.expects_time(n) {
                    p.final_time(n)?;
                    if !matches!(
                        s.peek(),
                        Token::End | Token::White | Token::Sym('Z' | '+' | '-')
                    ) {
                        return None;
                    }
                } else {
                    if p.day.len() >= 3 {
                        return None;
                    }
                    p.day.push(n);
                    s.skip('-');
                }
            }
            Token::AmPm(n) if !p.time.is_empty() => p.am_pm = Some(n),
            Token::Month(n) => {
                p.month = Some(n);
                s.skip('-');
            }
            Token::Zone(n) if number_seen => p.zone(n),
            Token::Sym('Z') if number_seen => p.zone(0),
            Token::Word | Token::Time | Token::Zone(_) | Token::AmPm(_) | Token::Sym('Z') => {
                if number_seen || matches!(s.peek(), Token::Num(_, _)) {
                    return None;
                }
            }
            Token::Sym(sign @ ('+' | '-'))
                if (p.zone_hour == Some(0) && p.zone_minute == Some(0)) || !p.time.is_empty() =>
            {
                p.sign = if sign == '-' { -1 } else { 1 };
                let (n, l) = if let Token::Num(n, l) = s.peek() {
                    s.next();
                    (n, l)
                } else {
                    (0, 0)
                };
                number_seen = true;
                if s.peek() == Token::Sym(':') {
                    p.zone_hour = Some(n);
                    p.zone_minute = None;
                } else {
                    match l {
                        1 | 2 => {
                            p.zone_hour = Some(n);
                            p.zone_minute = Some(0);
                        }
                        3 | 4 => {
                            p.zone_hour = Some(n / 100);
                            p.zone_minute = Some(n % 100);
                        }
                        _ => return None,
                    }
                }
            }
            Token::Sym('+' | '-' | ')') if number_seen => return None,
            _ => (),
        }
        token = s.next();
    }
    if p.day.is_empty() {
        return None;
    }
    p.day.resize(3, 1);
    p.time.resize(4, 0);
    let (mut y, m, d) = if let Some(m) = p.month {
        if !(1..=31).contains(&p.day[0]) {
            (p.day[0], m, p.day[1])
        } else {
            (p.day[1], m, p.day[0])
        }
    } else if p.iso || !(1..=31).contains(&p.day[0]) {
        (p.day[0], p.day[1], p.day[2])
    } else {
        (p.day[2], p.day[0], p.day[1])
    };
    if !p.iso {
        if (0..=49).contains(&y) {
            y += 2000;
        } else if (50..=99).contains(&y) {
            y += 1900;
        }
    }
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || y.abs() > 1_000_000 {
        return None;
    }
    if let Some(offset) = p.am_pm {
        if p.time[0] > 12 {
            return None;
        }
        p.time[0] = p.time[0] % 12 + offset;
    }
    let (h, mi, se, ms) = (p.time[0], p.time[1], p.time[2], p.time[3]);
    if (h > 23 || mi > 59 || se > 59 || ms > 999) && !(h == 24 && mi == 0 && se == 0 && ms == 0) {
        return None;
    }
    let wall = days(y, m, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + se * 1000 + ms;
    let utc = if p.sign != 0 {
        let offset = p.zone_hour.unwrap_or(0) * 3600 + p.zone_minute.unwrap_or(0) * 60;
        if offset > i32::MAX as i64 {
            return None;
        }
        wall - p.sign * offset * 1000
    } else {
        local_to_utc(wall)?
    };
    (utc.abs() <= 8_640_000_000_000_000).then_some(utc)
}
pub(crate) fn days(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yo = y - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    era * 146097 + yo * 365 + yo / 4 - yo / 100 + (153 * mp + 2) / 5 + d - 1 - 719468
}
/// Local legacy/date-time strings follow the host timezone, with the earlier
/// instant chosen on overlap and forward movement through a DST gap.
pub(crate) fn local_to_utc(wall: i64) -> Option<i64> {
    let mut candidates = Vec::new();
    for delta in [-172800, 0, 172800] {
        let t = (wall.div_euclid(1000) + delta) as libc::time_t;
        let mut tm = std::mem::MaybeUninit::<libc::tm>::uninit();
        // SAFETY: both pointers refer to correctly aligned, live storage;
        // localtime_r initializes tm on success and retains neither pointer.
        if unsafe { libc::localtime_r(&t, tm.as_mut_ptr()) }.is_null() {
            return None;
        }
        // SAFETY: successful localtime_r initialized every tm field.
        let tm = unsafe { tm.assume_init() };
        let candidate = wall - tm.tm_gmtoff * 1000;
        let seconds = candidate.div_euclid(1000) as libc::time_t;
        let mut actual = std::mem::MaybeUninit::<libc::tm>::uninit();
        // SAFETY: same valid input/output storage contract as above.
        if unsafe { libc::localtime_r(&seconds, actual.as_mut_ptr()) }.is_null() {
            return None;
        }
        // SAFETY: initialized by the successful call.
        let actual = unsafe { actual.assume_init() };
        candidates.push((candidate, candidate + actual.tm_gmtoff * 1000 == wall));
    }
    candidates
        .iter()
        .filter(|(_, matches)| *matches)
        .map(|(n, _)| *n)
        .min()
        .or_else(|| candidates.iter().map(|(n, _)| *n).max())
}
