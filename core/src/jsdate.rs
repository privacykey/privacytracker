//! `Date.prototype.toISOString` — the one date formatter the read API
//! needs, and the only reason a date helper exists here at all.
//!
//! Sibling of `jsnum.rs` and `jsstr.rs`. No calendar crate: the civil-date
//! arithmetic is Howard Hinnant's `civil_from_days`, twenty lines that are
//! exact for every epoch millisecond JavaScript can hold, and the test
//! constants below were read out of `node -e` rather than derived here.

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
}
