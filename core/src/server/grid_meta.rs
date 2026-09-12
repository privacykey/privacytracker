//! Port of `buildAppGridMeta` (`lib/app-grid-meta.ts`) and the four map
//! helpers it fans out to — the `&meta=grid` side-band the apps grid renders
//! alongside a page of apps.
//!
//! Three things carry the bytes here, and none of them is the SQL:
//!
//! 1. **Every map is a plain object keyed by app id**, and JavaScript walks
//!    array-index keys (canonical `0..2^32-2`) FIRST in ascending numeric
//!    order, then the rest by insertion. The seed's ids are numeric and the
//!    parity fixture's are `pt-fixture-*`, so a mixed page interleaves them
//!    unless the keys are ordered the JS way. `js_keyed_object` does that.
//! 2. **`computeProfileMismatch` breaks ties with `localeCompare`** — ICU
//!    collation, not byte order. On the fourteen real category keys the two
//!    disagree exactly once: ICU puts `CONTACT_INFO` before `CONTACTS`
//!    (the underscore is ignored at the primary level), byte order puts
//!    `CONTACTS` first (`S` < `_`). `locale_compare` below strips
//!    underscores before comparing and was checked against Node on all 196
//!    ordered pairs of that key set.
//! 3. **Each helper is individually try/caught in Node** with a per-map
//!    fallback (`{}`), so one failing read must not change the shape of the
//!    other three. A port that `?`s straight out of the whole function
//!    turns a partial answer into a 500.
//!
//! The `appDeviceMap` read is the one the harness had to be guarded for:
//! opening a database with the Rust core can WRITE `app_devices` rows (the
//! ported unknown-device backfill), so `read-parity.mjs` refuses a copy on
//! which that would fire. See `core/README.md`.

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::jsstr::js_keyed_object;

/// `(category, tier)` pairs in object-insertion order — a profile, or one
/// app's `worstByCategory` footprint.
type TierMap = Vec<(String, String)>;

/// `TIER_RANK` — the order the profile tiers escalate in.
fn tier_rank(tier: &str) -> Option<i64> {
    match tier {
        "not_collected" => Some(0),
        "not_linked" => Some(1),
        "linked" => Some(2),
        "tracking" => Some(3),
        _ => None,
    }
}

/// `TYPE_IDENTIFIER_TO_TIER` — which tier a privacy TYPE implies.
fn type_to_tier(type_identifier: &str) -> Option<&'static str> {
    match type_identifier {
        "DATA_NOT_LINKED_TO_YOU" => Some("not_linked"),
        "DATA_LINKED_TO_YOU" => Some("linked"),
        "DATA_USED_TO_TRACK_YOU" => Some("tracking"),
        _ => None,
    }
}

/// `CATEGORY_META[key].label` — the fourteen real keys. Note `OTHER`, not
/// `OTHER_DATA`.
fn category_label(key: &str) -> Option<&'static str> {
    Some(match key {
        "CONTACT_INFO" => "Contact Info",
        "HEALTH_AND_FITNESS" => "Health & Fitness",
        "FINANCIAL_INFO" => "Financial Info",
        "LOCATION" => "Location",
        "SENSITIVE_INFO" => "Sensitive Info",
        "CONTACTS" => "Contacts",
        "USER_CONTENT" => "User Content",
        "BROWSING_HISTORY" => "Browsing History",
        "SEARCH_HISTORY" => "Search History",
        "IDENTIFIERS" => "Identifiers",
        "PURCHASES" => "Purchases",
        "USAGE_DATA" => "Usage Data",
        "DIAGNOSTICS" => "Diagnostics",
        "OTHER" => "Other Data",
        _ => return None,
    })
}

/// `TIER_META[tier].shortLabel`, lower-cased as `describeWorstMismatch` does.
fn tier_short_label_lower(tier: &str) -> &'static str {
    match tier {
        "not_collected" => "not collected",
        "not_linked" => "not linked",
        "linked" => "linked",
        "tracking" => "tracking",
        _ => "",
    }
}

/// `a.localeCompare(b)` for the strings that reach it here — category keys
/// drawn from `CATEGORY_META`. ICU's primary strength ignores `_`, so
/// compare with underscores stripped and fall back to the raw strings only
/// on a primary tie. Verified against Node on every ordered pair of the
/// fourteen keys (196/196; byte order scores 194/196).
fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let strip = |s: &str| s.chars().filter(|c| *c != '_').collect::<String>();
    strip(a).cmp(&strip(b)).then_with(|| a.cmp(b))
}

/// `getSetting(PROFILE_SETTING_KEY, "")` then `parseStoredProfile`.
///
/// Reads `app_settings` directly rather than through `settings::get_setting`,
/// which takes the whole `AppState` and locks the connection itself — this
/// runs with the lock already held.
fn get_privacy_profile(conn: &Connection) -> rusqlite::Result<Option<TierMap>> {
    use rusqlite::OptionalExtension;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?",
            ["privacy_profile"],
            |row| row.get(0),
        )
        .optional()?;
    Ok(parse_stored_profile(raw.as_deref()))
}

/// `parseStoredProfile`: falsy → null; parse error → null; non-object or
/// array → null; otherwise keep only `CATEGORY_META` keys whose value is one
/// of the four tier strings, in the stored object's own key order — which
/// is `Object.entries` order, i.e. JS property order.
fn parse_stored_profile(raw: Option<&str>) -> Option<TierMap> {
    let raw = raw.filter(|s| !s.is_empty())?;
    let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(raw) else {
        return None;
    };
    let ordered = crate::jsstr::js_object_key_order(obj.keys().map(String::as_str));
    Some(
        ordered
            .into_iter()
            .filter(|k| category_label(k).is_some())
            .filter_map(|k| {
                let v = obj.get(k)?.as_str()?;
                tier_rank(v).map(|_| (k.to_string(), v.to_string()))
            })
            .collect(),
    )
}

/// `buildAllFootprints` + `rowsToFootprint`: per app, the WORST tier seen
/// per category. The category's POSITION is fixed by the first row that
/// mentions it (object insertion order), while its VALUE is the max tier
/// across all rows. The join has no ORDER BY, so that position — and thus
/// the order `computeProfileMismatch` sees on a tie — is planner order.
fn build_all_footprints(
    conn: &Connection,
    app_ids: &[String],
) -> rusqlite::Result<Vec<(String, TierMap)>> {
    if app_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; app_ids.len()].join(", ");
    let sql = format!(
        "SELECT t.app_id AS app_id, c.identifier AS identifier, t.identifier AS type_identifier \
           FROM privacy_categories c \
           JOIN privacy_types t ON c.type_id = t.id WHERE t.app_id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> =
        app_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok((
            row.get::<_, String>("app_id")?,
            row.get::<_, Option<String>>("identifier")?
                .unwrap_or_default(),
            row.get::<_, Option<String>>("type_identifier")?
                .unwrap_or_default(),
        ))
    })?;

    // Map<app_id, rows> in first-seen order, then rowsToFootprint per app.
    let mut by_app: Vec<(String, TierMap)> = Vec::new();
    for row in rows {
        let (app_id, identifier, type_identifier) = row?;
        let Some(tier) = type_to_tier(&type_identifier) else {
            continue;
        };
        // "not_collected" never comes from a type identifier, but the guard
        // is in the Node source and costs nothing.
        if tier == "not_collected" {
            continue;
        }
        let entry = match by_app.iter_mut().find(|(a, _)| *a == app_id) {
            Some(e) => e,
            None => {
                by_app.push((app_id.clone(), Vec::new()));
                by_app.last_mut().unwrap()
            }
        };
        match entry.1.iter_mut().find(|(k, _)| *k == identifier) {
            Some((_, existing)) => {
                if tier_rank(tier) > tier_rank(existing) {
                    *existing = tier.to_string();
                }
            }
            None => entry.1.push((identifier, tier.to_string())),
        }
    }
    Ok(by_app)
}

struct Mismatch {
    category: String,
    allowed: String,
    observed: String,
    severity_gap: i64,
}

struct MismatchResult {
    mismatches: Vec<Mismatch>,
    total_gap: i64,
    profile_active: bool,
}

/// `computeProfileMismatch`. Inactive when there is no profile or it holds no
/// string values. Walks the footprint in ITS order, then sorts worst-first
/// with the `localeCompare` tie-break.
fn compute_profile_mismatch(
    profile: Option<&[(String, String)]>,
    footprint: &[(String, String)],
) -> MismatchResult {
    let inactive = MismatchResult {
        mismatches: Vec::new(),
        total_gap: 0,
        profile_active: false,
    };
    let Some(profile) = profile else {
        return inactive;
    };
    if profile.is_empty() {
        return inactive;
    }

    let mut mismatches = Vec::new();
    let mut total_gap = 0;
    for (category, observed) in footprint {
        let Some((_, allowed)) = profile.iter().find(|(k, _)| k == category) else {
            continue;
        };
        let (Some(o), Some(a)) = (tier_rank(observed), tier_rank(allowed)) else {
            continue;
        };
        let gap = o - a;
        if gap >= 1 {
            mismatches.push(Mismatch {
                category: category.clone(),
                allowed: allowed.clone(),
                observed: observed.clone(),
                severity_gap: gap,
            });
            total_gap += gap;
        }
    }
    // `b.severityGap - a.severityGap || a.category.localeCompare(b.category)`
    mismatches.sort_by(|a, b| {
        b.severity_gap
            .cmp(&a.severity_gap)
            .then_with(|| locale_compare(&a.category, &b.category))
    });
    MismatchResult {
        mismatches,
        total_gap,
        profile_active: true,
    }
}

/// `describeWorstMismatch`.
fn describe_worst_mismatch(result: &MismatchResult) -> Option<String> {
    let top = result.mismatches.first()?;
    let label = category_label(&top.category).unwrap_or(&top.category);
    Some(format!(
        "{label}: {} (you allow {} at most)",
        tier_short_label_lower(&top.observed),
        tier_short_label_lower(&top.allowed)
    ))
}

/// `summariseBadge`, for an ACTIVE profile only — the caller skips inactive
/// results before ever getting here, so the `no_profile` literal is never
/// emitted by this route. All literals share one key order.
fn summarise_badge(result: &MismatchResult) -> Value {
    let count = result.mismatches.len() as i64;
    let mut m = Map::new();
    if count == 0 {
        m.insert("count".into(), Value::from(0));
        m.insert("totalGap".into(), Value::from(0));
        m.insert("tone".into(), Value::from("ok"));
        m.insert("kind".into(), Value::from("match"));
        m.insert("label".into(), Value::from("Matches profile"));
        m.insert(
            "description".into(),
            Value::from("Every category this app collects stays within your preferences."),
        );
        m.insert("worstCategory".into(), Value::Null);
        m.insert("worstCategoryLabel".into(), Value::Null);
        return Value::Object(m);
    }

    // `count >= 3 || totalGap >= 5 ? "bad" : totalGap >= 3 ? "bad" : "warn"`
    // — the middle arm is also "bad", so effectively totalGap >= 3.
    let tone = if count >= 3 || result.total_gap >= 3 {
        "bad"
    } else {
        "warn"
    };
    let top = &result.mismatches[0];
    let category_label_str = category_label(&top.category).unwrap_or(&top.category);
    let label = format!("{count} mismatch{}", if count == 1 { "" } else { "es" });
    let description = describe_worst_mismatch(result).unwrap_or_else(|| {
        format!(
            "{count} categor{} exceed your profile.",
            if count == 1 { "y" } else { "ies" }
        )
    });

    m.insert("count".into(), Value::from(count));
    m.insert("totalGap".into(), Value::from(result.total_gap));
    m.insert("tone".into(), Value::from(tone));
    m.insert("kind".into(), Value::from("mismatches"));
    m.insert("label".into(), Value::from(label));
    m.insert("description".into(), Value::from(description));
    m.insert("worstCategory".into(), Value::from(top.category.as_str()));
    m.insert("worstCategoryLabel".into(), Value::from(category_label_str));
    Value::Object(m)
}

/// `getProfileBadgesByApp(appIds)`: `{}` when there is no profile or no ids;
/// otherwise one badge per id whose result is active — and since a profile
/// with any preference makes EVERY result active, that is every id, footprint
/// or not (an app with no rows gets an empty footprint → "match").
fn get_profile_badges_by_app(conn: &Connection, app_ids: &[String]) -> rusqlite::Result<Value> {
    let Some(profile) = get_privacy_profile(conn)? else {
        return Ok(Value::Object(Map::new()));
    };
    if app_ids.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let footprints = build_all_footprints(conn, app_ids)?;
    let empty: TierMap = Vec::new();
    let mut pairs = Vec::with_capacity(app_ids.len());
    for id in app_ids {
        let footprint = footprints
            .iter()
            .find(|(a, _)| a == id)
            .map(|(_, f)| f.as_slice())
            .unwrap_or(&empty);
        let result = compute_profile_mismatch(Some(&profile), footprint);
        if !result.profile_active {
            continue;
        }
        pairs.push((id.clone(), summarise_badge(&result)));
    }
    Ok(js_keyed_object(pairs))
}

/// `getPendingChangeCategoriesByApp(appIds)`.
///
/// One `{privacy, accessibility, policy}` bucket per app that has a pending
/// snapshot, created on first sight (`??=`) with all three false. A null
/// summary or an unparseable one flips `privacy` — the older-writer
/// fallback. Here the `for…of` IS inside the try, so a valid-but-not-array
/// blob is caught and also flips `privacy`, unlike in `trend.rs`.
fn get_pending_change_categories_by_app(
    conn: &Connection,
    app_ids: &[String],
) -> rusqlite::Result<Value> {
    if app_ids.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let placeholders = vec!["?"; app_ids.len()].join(", ");
    let sql = format!(
        "SELECT ps.app_id, ps.changes_summary \
           FROM privacy_snapshots ps \
           JOIN apps a ON a.id = ps.app_id \
          WHERE ps.changes_detected = 1 \
            AND ps.scraped_at > COALESCE(a.changes_acknowledged_at, 0) AND ps.app_id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> =
        app_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok((
            row.get::<_, String>("app_id")?,
            row.get::<_, Option<String>>("changes_summary")?,
        ))
    })?;

    // (app_id, [privacy, accessibility, policy]) in first-seen order.
    let mut buckets: Vec<(String, [bool; 3])> = Vec::new();
    for row in rows {
        let (app_id, summary) = row?;
        let idx = match buckets.iter().position(|(a, _)| *a == app_id) {
            Some(i) => i,
            None => {
                buckets.push((app_id, [false; 3]));
                buckets.len() - 1
            }
        };
        let b = &mut buckets[idx].1;
        // `!row.changes_summary` — truthiness, so "" counts as missing.
        let Some(summary) = summary.filter(|s| !s.is_empty()) else {
            b[0] = true;
            continue;
        };
        match serde_json::from_str::<Value>(&summary) {
            Ok(Value::Array(entries)) => {
                for entry in entries {
                    // `entry.category ?? "privacy-label"` — `??`, so an
                    // explicit null is untagged; a non-string category
                    // matches none of the three and is ignored.
                    let cat = match entry.get("category") {
                        None | Some(Value::Null) => "privacy-label",
                        Some(Value::String(s)) => s.as_str(),
                        Some(_) => "",
                    };
                    match cat {
                        "accessibility" => b[1] = true,
                        "privacy-policy" => b[2] = true,
                        "privacy-label" => b[0] = true,
                        _ => {}
                    }
                }
            }
            // Parse failure, or valid JSON that `for…of` cannot iterate —
            // both land in the catch and flip privacy.
            _ => b[0] = true,
        }
    }

    Ok(js_keyed_object(
        buckets
            .into_iter()
            .map(|(id, [p, a, po])| {
                let mut m = Map::new();
                m.insert("privacy".into(), Value::Bool(p));
                m.insert("accessibility".into(), Value::Bool(a));
                m.insert("policy".into(), Value::Bool(po));
                (id, Value::Object(m))
            })
            .collect(),
    ))
}

/// `getUserVerdictsByAppId(appIds)` drained into `userVerdicts[id] =
/// v.verdict`. Only the `verdict` column survives to the wire. The query has
/// no ORDER BY and the Map is keyed by app id, so with two user rows for one
/// app the LAST in planner order wins — the position is the first's.
fn get_user_verdicts_by_app(conn: &Connection, app_ids: &[String]) -> rusqlite::Result<Value> {
    if app_ids.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let placeholders = vec!["?"; app_ids.len()].join(", ");
    let sql = format!(
        "SELECT id, app_id, verdict, rationale, source, source_name, set_at, updated_at \
     FROM app_verdicts \
     WHERE source = 'user' AND app_id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> =
        app_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok((
            row.get::<_, String>("app_id")?,
            super::row::column(row, "verdict")?,
        ))
    })?;
    let mut pairs: Vec<(String, Value)> = Vec::new();
    for row in rows {
        let (app_id, verdict) = row?;
        match pairs.iter_mut().find(|(a, _)| *a == app_id) {
            Some((_, v)) => *v = verdict,
            None => pairs.push((app_id, verdict)),
        }
    }
    Ok(js_keyed_object(pairs))
}

/// `getAppDeviceMap(appIds)` drained into `appDeviceMap[id] = ids`. The
/// device ids within an app keep planner order — there is no ORDER BY —
/// and are NOT deduplicated.
fn get_app_device_map(conn: &Connection, app_ids: &[String]) -> rusqlite::Result<Value> {
    if app_ids.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let placeholders = vec!["?"; app_ids.len()].join(", ");
    let sql = format!("SELECT app_id, device_id FROM app_devices WHERE app_id IN ({placeholders})");
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> =
        app_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok((
            row.get::<_, String>("app_id")?,
            super::row::column(row, "device_id")?,
        ))
    })?;
    let mut pairs: Vec<(String, Vec<Value>)> = Vec::new();
    for row in rows {
        let (app_id, device_id) = row?;
        match pairs.iter_mut().find(|(a, _)| *a == app_id) {
            Some((_, list)) => list.push(device_id),
            None => pairs.push((app_id, vec![device_id])),
        }
    }
    Ok(js_keyed_object(
        pairs
            .into_iter()
            .map(|(id, list)| (id, Value::Array(list)))
            .collect(),
    ))
}

/// `buildAppGridMeta(appIds)`. Each helper's failure is swallowed to its own
/// `{}` — never propagated — and the return literal's key order is
/// `appDeviceMap, pendingChangeCategoriesByApp, profileBadges, userVerdicts`.
pub fn build_app_grid_meta(conn: &Connection, app_ids: &[String]) -> rusqlite::Result<Value> {
    let empty = || Value::Object(Map::new());
    // `try { … } catch { console.warn(…) }` — the fallback is the empty
    // object, and the warning is the only trace. Reproduced per helper.
    let profile_badges = get_profile_badges_by_app(conn, app_ids).unwrap_or_else(|e| {
        eprintln!("[app-grid-meta] getProfileBadgesByApp failed: {e}");
        empty()
    });
    let pending = get_pending_change_categories_by_app(conn, app_ids).unwrap_or_else(|e| {
        eprintln!("[app-grid-meta] getPendingChangeCategoriesByApp failed: {e}");
        empty()
    });
    let user_verdicts = get_user_verdicts_by_app(conn, app_ids).unwrap_or_else(|e| {
        eprintln!("[app-grid-meta] getUserVerdictsByAppId failed: {e}");
        empty()
    });
    let app_device_map = get_app_device_map(conn, app_ids).unwrap_or_else(|e| {
        eprintln!("[app-grid-meta] getAppDeviceMap failed: {e}");
        empty()
    });

    let mut m = Map::new();
    m.insert("appDeviceMap".into(), app_device_map);
    m.insert("pendingChangeCategoriesByApp".into(), pending);
    m.insert("profileBadges".into(), profile_badges);
    m.insert("userVerdicts".into(), user_verdicts);
    Ok(Value::Object(m))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn locale_compare_matches_icu_on_the_pair_byte_order_gets_wrong() {
        use std::cmp::Ordering::*;
        // ICU: CONTACT_INFO < CONTACTS. Bytes: 'S' (0x53) < '_' (0x5F).
        assert_eq!(locale_compare("CONTACT_INFO", "CONTACTS"), Less);
        assert_eq!(
            "CONTACT_INFO".cmp("CONTACTS"),
            Greater,
            "byte order disagrees"
        );
        // Full Node order of the 14 keys, verified with localeCompare.
        let mut keys = vec![
            "CONTACT_INFO",
            "USER_CONTENT",
            "SEARCH_HISTORY",
            "IDENTIFIERS",
            "USAGE_DATA",
            "DIAGNOSTICS",
            "LOCATION",
            "PURCHASES",
            "FINANCIAL_INFO",
            "HEALTH_AND_FITNESS",
            "SENSITIVE_INFO",
            "CONTACTS",
            "BROWSING_HISTORY",
            "OTHER_DATA",
        ];
        keys.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            keys,
            [
                "BROWSING_HISTORY",
                "CONTACT_INFO",
                "CONTACTS",
                "DIAGNOSTICS",
                "FINANCIAL_INFO",
                "HEALTH_AND_FITNESS",
                "IDENTIFIERS",
                "LOCATION",
                "OTHER_DATA",
                "PURCHASES",
                "SEARCH_HISTORY",
                "SENSITIVE_INFO",
                "USAGE_DATA",
                "USER_CONTENT"
            ]
        );
    }

    #[test]
    fn stored_profile_keeps_only_known_categories_with_valid_tiers() {
        assert_eq!(parse_stored_profile(None), None);
        assert_eq!(parse_stored_profile(Some("")), None);
        assert_eq!(parse_stored_profile(Some("[1]")), None);
        assert_eq!(parse_stored_profile(Some("nope")), None);
        // An object with nothing valid is Some(empty) — a profile that is
        // present but INACTIVE, which computeProfileMismatch treats like none.
        assert_eq!(parse_stored_profile(Some("{}")), Some(vec![]));
        let p = parse_stored_profile(Some(
            r#"{"LOCATION":"linked","BOGUS":"linked","CONTACTS":"sideways","OTHER":"tracking"}"#,
        ))
        .unwrap();
        assert_eq!(
            p,
            vec![
                ("LOCATION".into(), "linked".into()),
                ("OTHER".into(), "tracking".into())
            ]
        );
    }

    #[test]
    fn mismatch_sort_is_worst_first_then_locale_order() {
        let profile = vec![
            ("CONTACTS".to_string(), "not_linked".to_string()),
            ("CONTACT_INFO".to_string(), "not_linked".to_string()),
            ("LOCATION".to_string(), "not_linked".to_string()),
        ];
        // Footprint order deliberately CONTACTS-first; all gaps equal (2).
        let footprint = vec![
            ("CONTACTS".to_string(), "tracking".to_string()),
            ("CONTACT_INFO".to_string(), "tracking".to_string()),
            ("LOCATION".to_string(), "linked".to_string()), // gap 1
        ];
        let r = compute_profile_mismatch(Some(&profile), &footprint);
        let order: Vec<&str> = r.mismatches.iter().map(|m| m.category.as_str()).collect();
        // gap 2s first, tie broken by ICU (CONTACT_INFO before CONTACTS),
        // then the gap-1 LOCATION.
        assert_eq!(order, ["CONTACT_INFO", "CONTACTS", "LOCATION"]);
        assert_eq!(r.total_gap, 5);
        assert!(r.profile_active);
        // A category the profile has no opinion on is skipped, not a mismatch.
        let r2 = compute_profile_mismatch(
            Some(&profile),
            &[("IDENTIFIERS".to_string(), "tracking".to_string())],
        );
        assert!(r2.mismatches.is_empty());
        // No profile / empty profile → inactive.
        assert!(!compute_profile_mismatch(None, &footprint).profile_active);
        assert!(!compute_profile_mismatch(Some(&[]), &footprint).profile_active);
    }

    #[test]
    fn badge_literals_share_one_key_order_and_tone_thresholds() {
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        let expected = [
            "count",
            "totalGap",
            "tone",
            "kind",
            "label",
            "description",
            "worstCategory",
            "worstCategoryLabel",
        ];
        let none = summarise_badge(&MismatchResult {
            mismatches: vec![],
            total_gap: 0,
            profile_active: true,
        });
        assert_eq!(keys(&none), expected);
        assert_eq!(none["kind"], "match");
        assert_eq!(none["worstCategory"], Value::Null);

        let one = |gap: i64, n: usize| MismatchResult {
            mismatches: (0..n)
                .map(|i| Mismatch {
                    category: ["CONTACTS", "LOCATION", "PURCHASES"][i].to_string(),
                    allowed: "not_linked".into(),
                    observed: "tracking".into(),
                    severity_gap: gap,
                })
                .collect(),
            total_gap: gap * n as i64,
            profile_active: true,
        };
        let b = summarise_badge(&one(1, 1));
        assert_eq!(keys(&b), expected);
        assert_eq!(b["tone"], "warn");
        assert_eq!(b["label"], "1 mismatch");
        assert_eq!(
            b["description"],
            "Contacts: tracking (you allow not linked at most)"
        );
        assert_eq!(b["worstCategoryLabel"], "Contacts");
        // totalGap >= 3 → bad; count >= 3 → bad.
        assert_eq!(summarise_badge(&one(3, 1))["tone"], "bad");
        assert_eq!(summarise_badge(&one(1, 3))["tone"], "bad");
        assert_eq!(summarise_badge(&one(1, 2))["label"], "2 mismatches");
    }

    #[test]
    fn pending_buckets_follow_the_three_rules() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE apps (id TEXT PRIMARY KEY, changes_acknowledged_at INTEGER);
             CREATE TABLE privacy_snapshots (app_id TEXT, changes_detected INTEGER, scraped_at INTEGER, changes_summary TEXT);
             INSERT INTO apps VALUES ('a', 0), ('b', 100), ('c', 0), ('d', 0);
             INSERT INTO privacy_snapshots VALUES
               ('a', 1, 5, '[{\"type\":\"added\"},{\"type\":\"x\",\"category\":\"accessibility\"}]'),
               ('b', 1, 50, '[{\"category\":\"privacy-policy\"}]'),  -- acknowledged after: excluded
               ('c', 1, 5, NULL),                                      -- null summary → privacy
               ('c', 0, 6, '[{\"category\":\"privacy-policy\"}]'),    -- not detected: excluded
               ('d', 1, 5, '{}');                                      -- non-array → caught → privacy",
        )
        .unwrap();
        let ids: Vec<String> = ["a", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
        let v = get_pending_change_categories_by_app(&c, &ids).unwrap();
        assert_eq!(
            v,
            json!({
                "a": {"privacy": true, "accessibility": true, "policy": false},
                "c": {"privacy": true, "accessibility": false, "policy": false},
                "d": {"privacy": true, "accessibility": false, "policy": false}
            })
        );
        assert_eq!(
            serde_json::to_string(&v["a"]).unwrap(),
            r#"{"privacy":true,"accessibility":true,"policy":false}"#
        );
    }

    #[test]
    fn maps_emit_numeric_ids_first_ascending_then_string_ids() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE app_devices (app_id TEXT, device_id TEXT);
             INSERT INTO app_devices VALUES ('pt-z','d1'), ('10','d1'), ('2','d1'), ('2','d2'), ('pt-a','d1');",
        )
        .unwrap();
        let ids: Vec<String> = ["pt-z", "10", "2", "pt-a"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let v = get_app_device_map(&c, &ids).unwrap();
        assert_eq!(
            serde_json::to_string(&v).unwrap(),
            r#"{"2":["d1","d2"],"10":["d1"],"pt-z":["d1"],"pt-a":["d1"]}"#
        );
    }

    #[test]
    fn the_meta_envelope_is_in_literal_order_and_empty_maps_are_objects() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE apps (id TEXT PRIMARY KEY, changes_acknowledged_at INTEGER);
             CREATE TABLE privacy_snapshots (app_id TEXT, changes_detected INTEGER, scraped_at INTEGER, changes_summary TEXT);
             CREATE TABLE app_verdicts (id TEXT, app_id TEXT, verdict TEXT, rationale TEXT, source TEXT, source_name TEXT, set_at INTEGER, updated_at INTEGER);
             CREATE TABLE app_devices (app_id TEXT, device_id TEXT);
             CREATE TABLE privacy_types (id TEXT, app_id TEXT, identifier TEXT);
             CREATE TABLE privacy_categories (id TEXT, type_id TEXT, identifier TEXT);",
        )
        .unwrap();
        let v = build_app_grid_meta(&c, &["1".to_string()]).unwrap();
        assert_eq!(
            serde_json::to_string(&v).unwrap(),
            r#"{"appDeviceMap":{},"pendingChangeCategoriesByApp":{},"profileBadges":{},"userVerdicts":{}}"#
        );
        // And an empty id list short-circuits every helper the same way.
        let v0 = build_app_grid_meta(&c, &[]).unwrap();
        assert_eq!(v, v0);
    }

    #[test]
    fn a_failing_helper_falls_back_to_an_empty_object_without_touching_the_others() {
        // No app_verdicts table at all → that helper errors → `{}`, while the
        // device map (whose table exists) still populates.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE apps (id TEXT PRIMARY KEY, changes_acknowledged_at INTEGER);
             CREATE TABLE privacy_snapshots (app_id TEXT, changes_detected INTEGER, scraped_at INTEGER, changes_summary TEXT);
             CREATE TABLE app_devices (app_id TEXT, device_id TEXT);
             CREATE TABLE privacy_types (id TEXT, app_id TEXT, identifier TEXT);
             CREATE TABLE privacy_categories (id TEXT, type_id TEXT, identifier TEXT);
             INSERT INTO app_devices VALUES ('1', 'dev');",
        )
        .unwrap();
        let v = build_app_grid_meta(&c, &["1".to_string()]).unwrap();
        assert_eq!(v["userVerdicts"], json!({}));
        assert_eq!(v["appDeviceMap"], json!({"1": ["dev"]}));
    }
}
