//! lib/region.ts `normalizeCountry`: the storefront the iTunes lookup and
//! search use. Trimmed and lowercased; an alpha-3 code is cut to two
//! letters; anything not on the list is the default.
use crate::jsstr::{js_length, js_slice_prefix, js_trim};

pub const DEFAULT_COUNTRY: &str = "us";

const VALID_CODES: &[&str] = &[
    "us", "au", "gb", "ca", "nz", "ie", "de", "fr", "it", "es", "nl", "se", "no", "dk", "fi", "pl",
    "ch", "at", "be", "pt", "jp", "kr", "cn", "hk", "tw", "sg", "in", "id", "ph", "my", "th", "vn",
    "ae", "sa", "il", "tr", "za", "mx", "br", "ar", "cl", "co",
];

pub fn normalize_country(input: Option<&str>) -> String {
    let Some(input) = input else {
        return DEFAULT_COUNTRY.to_string();
    };
    let trimmed = js_trim(input).to_lowercase();
    if trimmed.is_empty() {
        return DEFAULT_COUNTRY.to_string();
    }
    let candidate = if js_length(&trimmed) > 2 {
        js_slice_prefix(&trimmed, 2)
    } else {
        trimmed
    };
    if VALID_CODES.contains(&candidate.as_str()) {
        candidate
    } else {
        DEFAULT_COUNTRY.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_country;

    #[test]
    fn matches_node_normalize_country() {
        assert_eq!(normalize_country(Some(" GB ")), "gb");
        assert_eq!(normalize_country(Some("aus")), "au");
        assert_eq!(normalize_country(Some("zz")), "us");
        assert_eq!(normalize_country(Some("")), "us");
        assert_eq!(normalize_country(None), "us");
    }
}
