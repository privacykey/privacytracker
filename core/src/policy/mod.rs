//! Phase 5: the AI policy pipeline — `lib/privacy-policy.ts` and the modules
//! around it. Batch 1 is the source layer: `fetchPrivacyPolicySource` from
//! a policy URL to a validated text or a structured failure, gated by
//! `core/tests/fixtures/policy-source-cases.json`. Nothing here touches the
//! database; the store, the summariser and the runner follow in later
//! batches.
pub mod diag;
pub mod source;
pub mod text;
pub mod url;

#[cfg(test)]
mod source_tests;

/// `n.toLocaleString()` under Node's default `en-US`: digits in groups of
/// three, comma separated. Every trace note that reports a length uses it.
pub(crate) fn locale_int(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn locale_int_groups_thousands() {
        assert_eq!(super::locale_int(0), "0");
        assert_eq!(super::locale_int(999), "999");
        assert_eq!(super::locale_int(1000), "1,000");
        assert_eq!(super::locale_int(1234567), "1,234,567");
    }
}
