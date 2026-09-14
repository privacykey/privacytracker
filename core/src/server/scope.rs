//! Request-only device scope. Unknown/stale selections fail open, just as
//! `scopeFromRequest` does; the stored UI preference is never consulted.
use super::stats::query;
use crate::jsstr::is_js_whitespace;
use rusqlite::{types::Value as SqlValue, Connection};
use std::collections::HashSet;

#[derive(Default)]
pub(super) struct Scope {
    ids: Vec<String>,
    unattached: bool,
}
impl Scope {
    pub fn from_request(conn: &Connection, raw: Option<&str>) -> Self {
        let known = query(conn, "SELECT id FROM devices", &[]).unwrap_or_default();
        Self::parse(
            raw,
            &known
                .iter()
                .filter_map(|r| r["id"].as_str())
                .collect::<Vec<_>>(),
        )
    }
    fn parse(raw: Option<&str>, known: &[&str]) -> Self {
        let raw = raw.unwrap_or("").trim_matches(is_js_whitespace);
        if raw.is_empty() || raw == "all" {
            return Self::default();
        }
        let selection: HashSet<_> = raw
            .split(',')
            .map(|s| s.trim_matches(is_js_whitespace))
            .collect();
        let ids: Vec<_> = known
            .iter()
            .filter(|id| selection.contains(**id))
            .map(|id| id.to_string())
            .collect();
        let unattached = selection.contains("unattached");
        if (ids.is_empty() && !unattached) || (ids.len() == known.len() && unattached) {
            Self::default()
        } else {
            Self { ids, unattached }
        }
    }
    pub fn all(&self) -> bool {
        self.ids.is_empty() && !self.unattached
    }
    /// The expression must be a literal column name from a caller, never request data.
    pub fn clause(&self, expr: &str) -> String {
        let mut terms = Vec::new();
        if !self.ids.is_empty() {
            let placeholders = vec!["?"; self.ids.len()].join(", ");
            terms.push(format!("EXISTS (SELECT 1 FROM app_devices ad WHERE ad.app_id = {expr} AND ad.device_id IN ({placeholders}))"));
        }
        if self.unattached {
            terms.push(format!(
                "NOT EXISTS (SELECT 1 FROM app_devices adu WHERE adu.app_id = {expr})"
            ));
        }
        if terms.is_empty() {
            String::new()
        } else {
            format!("({})", terms.join(" OR "))
        }
    }
    pub fn fragment(&self, prefix: &str, expr: &str) -> String {
        let clause = self.clause(expr);
        if clause.is_empty() {
            String::new()
        } else {
            format!(" {prefix} {clause}")
        }
    }
    pub fn by_id(&self, prefix: &str, expr: &str) -> String {
        if self.all() {
            String::new()
        } else {
            format!(
                " {prefix} EXISTS (SELECT 1 FROM apps sa WHERE sa.id = {expr} AND {})",
                self.clause("sa.id")
            )
        }
    }
    pub fn params(&self) -> Vec<SqlValue> {
        self.ids.iter().cloned().map(SqlValue::Text).collect()
    }
    pub fn allowed(&self, conn: &Connection) -> Option<HashSet<String>> {
        if self.all() {
            return None;
        }
        match query(
            conn,
            &format!("SELECT a.id FROM apps a{}", self.fragment("WHERE", "a.id")),
            &self.params(),
        ) {
            Ok(rows) => Some(
                rows.iter()
                    .filter_map(|r| r["id"].as_str().map(str::to_owned))
                    .collect(),
            ),
            Err(e) => {
                super::diag::log_warn(format!("[device-scope] getScopedAppIds failed: {e}"));
                None
            }
        }
    }
}
