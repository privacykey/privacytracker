//! `diffPolicyTexts` from `lib/policy-diff.ts`: a line diff by longest
//! common subsequence, with each paired removed/added run refined word by
//! word, behind `GET /api/policy/version/[id]/diff`.
//!
//! This is the algorithm as fixed in #273. Node's common-suffix trim used to
//! count from the start of both arrays instead of the end, so the History
//! tab reported real changes as unchanged; the port follows the fixed code,
//! which `tests/app/policy-diff.test.ts` pins on the Node side.
//!
//! Strings compare by value, lines split on `\n` after `\r\n` is folded,
//! and a line tokenises into runs of JavaScript whitespace and runs of
//! everything else, which is what `line.split(/(\s+)/)` with its empty
//! pieces filtered out produces.
use crate::jsstr::is_js_whitespace;
use serde_json::{json, Map, Value};

/// Past this many lines on either side the diff covers only the first
/// this-many and says it is truncated.
const MAX_LINES: usize = 2000;
/// Past this many tokens on either line, a pair is not refined.
const MAX_WORDS_PER_LINE: usize = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Unchanged,
    Added,
    Removed,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Unchanged => "unchanged",
            Kind::Added => "added",
            Kind::Removed => "removed",
        }
    }
}

type Op<'a> = (Kind, &'a str);

fn entry(kind: Kind, text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("type".into(), json!(kind.as_str()));
    out.insert("text".into(), json!(text));
    out
}

/// `diffPolicyTexts(oldText, newText)`: `{ lines, stats }`.
pub fn diff_policy_texts(old_text: &str, new_text: &str) -> Value {
    let old_all = split_lines(old_text);
    let new_all = split_lines(new_text);
    let truncated = old_all.len() > MAX_LINES || new_all.len() > MAX_LINES;
    let old_lines: Vec<&str> = old_all.iter().take(MAX_LINES).map(String::as_str).collect();
    let new_lines: Vec<&str> = new_all.iter().take(MAX_LINES).map(String::as_str).collect();

    let ops = lcs_diff(&old_lines, &new_lines);
    let mut lines: Vec<Value> = Vec::new();
    let (mut added, mut removed, mut unchanged) = (0u64, 0u64, 0u64);
    let mut i = 0;
    while i < ops.len() {
        let (kind, text) = ops[i];
        if kind == Kind::Unchanged {
            lines.push(Value::Object(entry(Kind::Unchanged, text)));
            unchanged += 1;
            i += 1;
            continue;
        }
        let mut run_removed: Vec<&str> = Vec::new();
        let mut run_added: Vec<&str> = Vec::new();
        while i < ops.len() && ops[i].0 != Kind::Unchanged {
            if ops[i].0 == Kind::Removed {
                run_removed.push(ops[i].1);
            } else {
                run_added.push(ops[i].1);
            }
            i += 1;
        }
        let pairs = run_removed.len().min(run_added.len());
        for k in 0..pairs {
            let (old_line, new_line) = (run_removed[k], run_added[k]);
            let words = refine_word_diff(old_line, new_line);
            let mut removed_line = entry(Kind::Removed, old_line);
            let mut added_line = entry(Kind::Added, new_line);
            if let Some(words) = &words {
                let pick = |skip: Kind| {
                    Value::Array(
                        words
                            .iter()
                            .filter(|(kind, _)| *kind != skip)
                            .map(|(kind, text)| Value::Object(entry(*kind, text)))
                            .collect(),
                    )
                };
                removed_line.insert("words".into(), pick(Kind::Added));
                added_line.insert("words".into(), pick(Kind::Removed));
            }
            lines.push(Value::Object(removed_line));
            lines.push(Value::Object(added_line));
            removed += 1;
            added += 1;
        }
        for text in &run_removed[pairs..] {
            lines.push(Value::Object(entry(Kind::Removed, text)));
            removed += 1;
        }
        for text in &run_added[pairs..] {
            lines.push(Value::Object(entry(Kind::Added, text)));
            added += 1;
        }
    }
    json!({
        "lines": lines,
        "stats": {
            "added": added,
            "removed": removed,
            "unchanged": unchanged,
            "truncated": truncated,
        },
    })
}

/// `splitLines`: nothing for an empty text, else the lines of the text
/// with `\r\n` folded to `\n`.
fn split_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    text.replace("\r\n", "\n")
        .split('\n')
        .map(str::to_string)
        .collect()
}

/// `lcsDiff`: the common prefix and suffix peeled off, the middle by LCS,
/// the suffix appended from the new side (it matches the old side there).
fn lcs_diff<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<Op<'a>> {
    let mut ops: Vec<Op<'a>> = Vec::new();
    let mut prefix = 0;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        ops.push((Kind::Unchanged, a[prefix]));
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < a.len() - prefix
        && suffix < b.len() - prefix
        && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix]
    {
        suffix += 1;
    }
    ops.extend(lcs_diff_core(
        &a[prefix..a.len() - suffix],
        &b[prefix..b.len() - suffix],
    ));
    ops.extend(b[b.len() - suffix..].iter().map(|t| (Kind::Unchanged, *t)));
    ops
}

/// `lcsDiffCore`: the LCS table from the bottom right, then the walk that
/// prefers a removal when both directions keep the LCS.
fn lcs_diff_core<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<Op<'a>> {
    let (n, m) = (a.len(), b.len());
    if n == 0 {
        return b.iter().map(|t| (Kind::Added, *t)).collect();
    }
    if m == 0 {
        return a.iter().map(|t| (Kind::Removed, *t)).collect();
    }
    let stride = m + 1;
    let mut dp = vec![0i32; (n + 1) * stride];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i * stride + j] = if a[i] == b[j] {
                dp[(i + 1) * stride + j + 1] + 1
            } else {
                dp[(i + 1) * stride + j].max(dp[i * stride + j + 1])
            };
        }
    }
    let mut ops = Vec::with_capacity(n + m);
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            ops.push((Kind::Unchanged, a[i]));
            i += 1;
            j += 1;
        } else if dp[(i + 1) * stride + j] >= dp[i * stride + j + 1] {
            ops.push((Kind::Removed, a[i]));
            i += 1;
        } else {
            ops.push((Kind::Added, b[j]));
            j += 1;
        }
    }
    ops.extend(a[i..].iter().map(|t| (Kind::Removed, *t)));
    ops.extend(b[j..].iter().map(|t| (Kind::Added, *t)));
    ops
}

/// `refineWordDiff`: the pair's token diff, or nothing past the cap.
fn refine_word_diff<'a>(old_line: &'a str, new_line: &'a str) -> Option<Vec<Op<'a>>> {
    let old_tokens = tokenise_line(old_line);
    let new_tokens = tokenise_line(new_line);
    if old_tokens.len() > MAX_WORDS_PER_LINE || new_tokens.len() > MAX_WORDS_PER_LINE {
        return None;
    }
    Some(lcs_diff(&old_tokens, &new_tokens))
}

/// `line.split(/(\s+)/).filter((p) => p.length > 0)`: alternating runs of
/// whitespace and of everything else.
fn tokenise_line(line: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut start = 0;
    let mut in_space: Option<bool> = None;
    for (at, c) in line.char_indices() {
        let space = is_js_whitespace(c);
        if in_space.is_some_and(|s| s != space) {
            tokens.push(&line[start..at]);
            start = at;
        }
        in_space = Some(space);
    }
    if start < line.len() {
        tokens.push(&line[start..]);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_one_word_edit_is_marked_word_by_word() {
        let diff = diff_policy_texts("The quick brown fox", "The quick red fox");
        assert_eq!(
            diff["stats"],
            json!({"added": 1, "removed": 1, "unchanged": 0, "truncated": false})
        );
        let words: Vec<String> = diff["lines"][0]["words"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| {
                format!(
                    "{}:{}",
                    &w["type"].as_str().unwrap()[..1],
                    w["text"].as_str().unwrap()
                )
            })
            .collect();
        assert_eq!(
            words,
            ["u:The", "u: ", "u:quick", "u: ", "r:brown", "u: ", "u:fox"]
        );
    }

    #[test]
    fn tokens_alternate_and_empty_texts_have_no_lines() {
        assert_eq!(
            tokenise_line("  a b\u{a0} "),
            ["  ", "a", " ", "b", "\u{a0} "]
        );
        assert!(tokenise_line("").is_empty());
        assert_eq!(diff_policy_texts("", "")["lines"], json!([]));
        assert_eq!(split_lines("a\r\nb\n"), ["a", "b", ""]);
    }
}
