//! JavaScript `Date` semantics the read API needs: `toISOString` here, and
//! `Date.parse` in the `parse` submodule — a port of V8's parser, attributed
//! in `core/V8-LICENSE`.
//!
//! Sibling of `jsnum.rs` and `jsstr.rs`. No calendar crate: the civil-date
//! arithmetic is Howard Hinnant's `civil_from_days`, twenty lines that are
//! exact for every epoch millisecond JavaScript can hold, and the test
//! constants below were read out of `node -e` rather than derived here.

mod parse;
pub use parse::parse;
pub(crate) use parse::{days as days_from_civil, local_to_utc};

/// The local-time fields of an epoch millisecond, as `Date.prototype`'s
/// `getFullYear`/`getMonth`/`getDate`/`getHours`/… report them in the
/// process timezone. `month` is 1-based here (JavaScript's is 0-based).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub millisecond: u32,
}

/// `new Date(ms)` read through the local-time getters, via `localtime_r`.
pub fn local_time(ms: i64) -> Option<LocalTime> {
    let seconds = ms.div_euclid(1000) as libc::time_t;
    let mut tm = std::mem::MaybeUninit::<libc::tm>::uninit();
    // SAFETY: both pointers refer to correctly aligned, live storage;
    // localtime_r initializes tm on success and retains neither pointer.
    if unsafe { libc::localtime_r(&seconds, tm.as_mut_ptr()) }.is_null() {
        return None;
    }
    // SAFETY: successful localtime_r initialized every tm field.
    let tm = unsafe { tm.assume_init() };
    Some(LocalTime {
        year: i64::from(tm.tm_year) + 1900,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec as u32,
        millisecond: ms.rem_euclid(1000) as u32,
    })
}

/// `date.setHours(h, m, 0, 0)` (optionally after `setDate(getDate() + days)`)
/// on a `Date` holding `ms`: the same local calendar day, the given wall
/// time, converted back to UTC by the rules `Date.parse` uses for local
/// input.
pub fn at_local_time(ms: i64, hour: u32, minute: u32, days_ahead: i64) -> Option<i64> {
    let local = local_time(ms)?;
    let day =
        days_from_civil(local.year, i64::from(local.month), i64::from(local.day)) + days_ahead;
    let wall = day * 86_400_000 + i64::from(hour) * 3_600_000 + i64::from(minute) * 60_000;
    local_to_utc(wall)
}

/// `new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short",
/// year: "numeric" }).format(new Date(ms))` in the process timezone. The
/// en-AU short months are the ICU ones Node ships, which spell June, July
/// and Sept in full.
pub fn en_au_short_date(ms: i64) -> Option<String> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec",
    ];
    let local = local_time(ms)?;
    Some(format!(
        "{} {} {}",
        local.day,
        MONTHS[(local.month - 1) as usize],
        local.year
    ))
}

/// `new Date(ms).toISOString()`: `YYYY-MM-DDTHH:MM:SS.mmmZ`, always UTC,
/// always three fraction digits. Years outside `0..=9999` take the
/// six-digit signed form JavaScript uses (`+010000-01-01T…`,
/// `-000001-…`); nothing this server emits reaches them.
pub fn js_iso_string(ms: i64) -> String {
    const DAY_MS: i64 = 86_400_000;
    let days = ms.div_euclid(DAY_MS);
    let rem = ms.rem_euclid(DAY_MS);
    let (y, m, d) = civil_from_days(days);
    let h = rem / 3_600_000;
    let mi = (rem / 60_000) % 60;
    let s = (rem / 1000) % 60;
    let milli = rem % 1000;
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("+{y:06}")
    };
    format!("{year}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

/// Days since 1970-01-01 → proleptic Gregorian (year, month, day).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::js_iso_string;

    #[test]
    fn matches_node_to_iso_string() {
        // Every pair is `new Date(ms).toISOString()` from node -e.
        let cases: &[(i64, &str)] = &[
            (0, "1970-01-01T00:00:00.000Z"),
            (1_700_000_000_000, "2023-11-14T22:13:20.000Z"),
            (1_789_257_958_110, "2026-09-13T00:05:58.110Z"),
            // Negative epoch: the millisecond before 1970.
            (-1, "1969-12-31T23:59:59.999Z"),
            // Leap days across the century rule.
            (951_782_400_000, "2000-02-29T00:00:00.000Z"),
            (1_709_164_800_123, "2024-02-29T00:00:00.123Z"),
            (253_402_300_799_999, "9999-12-31T23:59:59.999Z"),
        ];
        for (ms, expected) in cases {
            assert_eq!(js_iso_string(*ms), *expected, "{ms}");
        }
    }

    #[test]
    fn parse_matches_node_date_parse() {
        use super::parse;
        // Every pair is `Date.parse(s)` from node -e. These inputs carry
        // their own zone (or are date-only, which ISO reads as UTC) so the
        // process timezone cannot leak in; the 180-case oracle in
        // `server/operations_tests.rs` covers the local-time branches.
        assert_eq!(parse("2026-09-15T10:20:44.123Z"), Some(1_789_467_644_123));
        assert_eq!(parse("2026-09-15"), Some(1_789_430_400_000));
        assert_eq!(parse("September 15, 2026 GMT"), Some(1_789_430_400_000));
        // The collision suffix the backup writer appends is NaN in Node too,
        // so the listing falls back to mtime for those files.
        assert_eq!(parse("2026-09-15T10-20-44-123Z-2"), None);
        assert_eq!(parse("bad"), None);
    }

    #[test]
    fn local_helpers_match_node_in_utc() {
        use super::{at_local_time, en_au_short_date, local_time};
        let _env = crate::server::trust::env_lock();
        let previous = std::env::var("TZ").ok();
        std::env::set_var("TZ", "UTC");
        extern "C" {
            fn tzset();
        }
        // SAFETY: tzset takes no pointers; the env lock serializes the edit.
        unsafe { tzset() };
        // Every value is from node -e with TZ=UTC.
        let noon = 1_789_473_600_000; // 2026-09-15T12:00:00Z
        let t = local_time(noon).unwrap();
        assert_eq!(
            (t.year, t.month, t.day, t.hour, t.minute),
            (2026, 9, 15, 12, 0)
        );
        assert_eq!(at_local_time(noon, 23, 59, 0), Some(1_789_516_740_000));
        assert_eq!(at_local_time(noon, 6, 0, 1), Some(1_789_538_400_000));
        assert_eq!(en_au_short_date(noon).as_deref(), Some("15 Sept 2026"));
        assert_eq!(
            en_au_short_date(1_767_322_800_000).as_deref(),
            Some("2 Jan 2026")
        );
        assert_eq!(
            en_au_short_date(1_780_531_200_000).as_deref(),
            Some("4 June 2026")
        );
        match previous {
            Some(v) => std::env::set_var("TZ", v),
            None => std::env::remove_var("TZ"),
        }
        // SAFETY: restore the original timezone before releasing the env lock.
        unsafe { tzset() };
    }
}
