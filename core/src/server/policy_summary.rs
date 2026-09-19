//! Phase 5, batch 3a: the summarise phase of `syncPrivacyPolicyAnalysis`,
//! from `lib/privacy-policy.ts`.
//!
//! - `summariseStoredPolicy`: nothing to do when the stored summary is
//!   current, an imported excerpt, or not a clean source; the needs-config
//!   row when no provider is set; otherwise the summary, stored with the
//!   one it replaces, or the error it failed with. The needs-config row
//!   and the error are both stored beside the summary the run was
//!   replacing.
//! - `buildPolicySummary`: one call when the policy fits the model's
//!   direct limit; otherwise the policy in chunks, each chunk's notes
//!   stored as soon as they arrive (so a run that dies at the merge
//!   resumes from them), then the merge.
//! - `summarizeSamplePrivacyPolicy` and `buildPolicySummaryPromptPreview`,
//!   which batch 3b's routes serve.
//!
//! Two of Node's habits are kept. The run's `summarising` phase is closed
//! as a matter of course when the first chunk starts, so a chunked run's
//! "Summary ready" note lands on no phase at all. And the stored row's
//! `updated_at` is the time before the first AI call, not after the last.
#![cfg_attr(not(test), allow(dead_code))]

use super::{
    policy::{normalize_policy_summary, parse_stored_chunk_notes},
    policy_ai::{call_ai_json, get_ai_runtime_config, AiCall},
    policy_store::{
        analysis_mode, col, hydrate, persist, read_row, setting, sha256_hex, source_origin,
        sync_policy_analysis, FollowUps, Persist, Phase, PolicyRequest, RunLogger, SyncOptions,
        DELETE_PLACEHOLDER,
    },
    sync_runner::Clock,
};
use crate::{
    jsstr::{clean_sentence, js_length, js_string},
    outbound::Fetcher,
    policy::{
        ai::{provider_likely_needs_chunking, AiConfig, TimeoutPhase},
        locale_int,
        prompts::{
            build_chunk_prompt, build_direct_prompt, build_merge_prompt, chunk_note_schema,
            chunk_policy_text, final_summary_schema, POLICY_SYSTEM_PROMPT, SAMPLE_POLICY_APP_NAME,
            SAMPLE_POLICY_DEVELOPER, SAMPLE_POLICY_EXPECTED_SIGNALS,
            SAMPLE_POLICY_REVIEW_CHECKLIST, SAMPLE_POLICY_SCENARIO, SAMPLE_POLICY_TEXT,
            SAMPLE_POLICY_URL,
        },
        text::count_words,
    },
    scrape::{
        js::truthy,
        persist::{DbAccess, Ids},
    },
};
use serde_json::{json, Value};
use std::{future::Future, pin::Pin};

const PERSIST_CHUNK_NOTES: &str = "UPDATE privacy_policy_analyses\n        SET chunk_notes_json = ?, chunk_notes_hash = ?\n      WHERE app_id = ?";
const MAX_DIRECT_POLICY_CHARS: usize = 40_000;
const MAX_CHUNK_CHARS: usize = 12_000;
const NEEDS_CONFIG_ERROR: &str =
    "Configure an AI provider in Settings to enable privacy-policy summaries.";

/// One chunk's notes: its summary and highlights.
type ChunkNote = (String, Vec<String>);

/// `value ?? null` over a stored column, for the `??` chains.
fn defined(value: Value) -> Option<Value> {
    (!value.is_null()).then_some(value)
}

/// A summarise-phase write: the stored source carried over as it is, and
/// the fetch time left as the row has it, since the summarise path never
/// passes one.
fn persist_from(
    log: &mut RunLogger<'_>,
    existing: &Value,
    app_id: &str,
    policy_url: &str,
    fields: SummaryFields,
    updated_at: i64,
) -> Result<Value, String> {
    let log_json = log.to_json();
    let existing = Some(existing);
    let word_count = col(existing, "source_word_count");
    log.db().with(|w| {
        let fetched_at = col(read_row(w.conn, app_id)?.as_ref(), "source_fetched_at");
        let row = persist(
            w,
            app_id,
            policy_url,
            Persist {
                status: json!(fields.status),
                source_title: col(existing, "source_title"),
                source_content_type: col(existing, "source_content_type"),
                source_text: col(existing, "source_text"),
                source_word_count: if word_count.is_null() {
                    json!(0)
                } else {
                    word_count.clone()
                },
                source_origin: source_origin(&col(existing, "source_origin")),
                source_final_url: col(existing, "source_final_url"),
                content_hash: col(existing, "content_hash"),
                analysis_mode: fields.analysis_mode,
                summary_json: fields.summary_json,
                previous_summary_json: fields.previous_summary_json,
                previous_summary_at: fields.previous_summary_at,
                model: fields.model,
                error: fields.error.map_or(Value::Null, |e| json!(e)),
                source_fetched_at: fetched_at,
            },
            updated_at,
            log_json,
        )?;
        hydrate(w.conn, app_id, &row)
    })
}

/// What a summarise-phase write sets, each column the value bound; the
/// rest is the stored source.
struct SummaryFields {
    status: &'static str,
    analysis_mode: Value,
    summary_json: Value,
    previous_summary_json: Value,
    previous_summary_at: Value,
    model: Value,
    error: Option<String>,
}

/// The write of a run that made no summary, because it found no AI
/// provider or its AI call failed. Such a run replaces nothing: the row
/// keeps its summary, with the mode and model that made it, and the one
/// before it, as a failed fetch keeps its summary; only the status and
/// the error record the run. With no summary to keep, the row names
/// `model_without_summary`.
fn kept_summary(
    existing: &Value,
    has_summary: bool,
    status: &'static str,
    model_without_summary: Value,
    error: String,
) -> SummaryFields {
    let existing = Some(existing);
    SummaryFields {
        status,
        analysis_mode: if has_summary {
            analysis_mode(&col(existing, "analysis_mode"))
        } else {
            Value::Null
        },
        summary_json: col(existing, "summary_json"),
        previous_summary_json: col(existing, "previous_summary_json"),
        previous_summary_at: col(existing, "previous_summary_at"),
        model: if has_summary {
            col(existing, "model")
        } else {
            model_without_summary
        },
        error: Some(error),
    }
}

/// `summariseStoredPolicy`'s future. Boxed with `Send` stated rather than
/// inferred: the no-row branch runs the whole sync again, and the compiler
/// cannot infer `Send` through that cycle.
pub(super) type SummariseFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(Value, FollowUps), String>> + Send + 'a>>;

/// `summariseStoredPolicy`. The analysis, and what a nested full run left
/// to finish (only the unreachable no-row branch starts one).
pub(super) fn summarise_stored_policy<'a, 'b: 'a>(
    log: &'a mut RunLogger<'b>,
    ids: &'a mut dyn Ids,
    fetcher: &'a dyn Fetcher,
    clock: &'a dyn Clock,
    request: &'a PolicyRequest,
    force_resummarise: bool,
) -> SummariseFuture<'a> {
    Box::pin(summarise(
        log,
        ids,
        fetcher,
        clock,
        request,
        force_resummarise,
    ))
}

async fn summarise(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    clock: &dyn Clock,
    request: &PolicyRequest,
    force_resummarise: bool,
) -> Result<(Value, FollowUps), String> {
    let app_id = request.app_id.as_str();
    let Some(policy_url) = request.policy_url.as_deref().filter(|u| !u.is_empty()) else {
        return Ok((Value::Null, FollowUps::default()));
    };
    let existing = log.db().with(|w| read_row(w.conn, app_id))?;
    let Some(existing) = existing else {
        // The run marker always leaves a row behind it, so this is reached
        // only when something removes the row mid-run. Node then starts
        // the whole run over, marker, activity row and all.
        log.note(
            "restart",
            "No stored source; running full fetch + summarise.",
        );
        let synced = sync_policy_analysis(
            log.db(),
            ids,
            fetcher,
            clock,
            request,
            SyncOptions {
                phase: Phase::All,
                ..SyncOptions::default()
            },
        )
        .await?;
        return Ok((synced.analysis, synced.follow_ups));
    };
    // A policy that was never fetched has no text to summarise: its only
    // row is the run marker's placeholder (or one an earlier run left
    // behind), whose `pending` would hydrate as `analysis_error`. It is
    // dropped, and nothing is returned, as the kill-switch does for a
    // first fetch.
    if col(Some(&existing), "status") == "pending" {
        log.note(
            "skip",
            "Nothing to summarise: the policy has not been fetched yet. Rescrape the policy first.",
        );
        log.db()
            .with(|w| w.run(DELETE_PLACEHOLDER, vec![json!(app_id)]))?;
        return Ok((Value::Null, FollowUps::default()));
    }
    let hydrated =
        |log: &mut RunLogger<'_>, row: &Value| log.db().with(|w| hydrate(w.conn, app_id, row));
    let status = existing.get("status").cloned().unwrap_or(Value::Null);
    let has_summary = existing.get("summary_json").is_some_and(truthy);
    let has_text = existing.get("source_text").is_some_and(truthy);
    if !force_resummarise && status == "ready" && has_summary && has_text {
        log.note("skip", "Existing summary is already current.");
        return Ok((hydrated(log, &existing)?, FollowUps::default()));
    }
    if existing.get("model").and_then(Value::as_str) == Some("imported") {
        log.note(
            "skip",
            "Cannot summarise a policy from an imported audit bundle, which holds only an excerpt of the text. Rescrape the policy first.",
        );
        return Ok((hydrated(log, &existing)?, FollowUps::default()));
    }
    // `canSummariseStoredPolicy`: a clean capture whose summary is owed
    // (waiting for one, or after a summary run that found no provider or
    // failed, whether or not the failed run kept an earlier summary), or
    // on a forced run one already summarised.
    let can_summarise = status == "source_ready"
        || status == "needs_ai_config"
        || status == "analysis_error"
        || (force_resummarise && status == "ready");
    if !(can_summarise && has_text) {
        log.note(
            "skip",
            format!(
                "Cannot summarise — current status is {}.",
                js_string(&status)
            ),
        );
        return Ok((hydrated(log, &existing)?, FollowUps::default()));
    }

    let config = log.db().with(|w| get_ai_runtime_config(w.conn))?;
    let now = log.now();
    let Some(config) = config else {
        log.note("needs-config", "No AI provider configured in Settings.");
        let analysis = persist_from(
            log,
            &existing,
            app_id,
            policy_url,
            kept_summary(
                &existing,
                has_summary,
                "needs_ai_config",
                Value::Null,
                NEEDS_CONFIG_ERROR.to_string(),
            ),
            now,
        )?;
        return Ok((analysis, FollowUps::default()));
    };

    // `getActiveFocus().audience`: the stored value, `self` when unset.
    let guardian = setting(log, "flag.focus.audience", "") == "guardian";
    log.start_phase(
        "summarising",
        Some(format!("Using {} ({}).", config.label, config.model)),
    );
    let text = existing
        .get("source_text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let content_hash = existing
        .get("content_hash")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let built = build_policy_summary(
        log,
        ids,
        fetcher,
        &config,
        &Subject {
            app_id,
            app_name: &request.app_name,
            developer: request.developer.as_deref(),
            policy_url,
            policy_text: &text,
            content_hash: &content_hash,
        },
        guardian,
    )
    .await;
    let analysis = match built {
        Ok((summary, mode)) => {
            log.end_phase(Some(format!("Summary ready ({mode}).")), None);
            // `existing.summary_json ?? existing.previous_summary_json ?? null`
            // and its time, the fetch phase's rule: the summary this run
            // replaces, which is the row's own when it has one (a forced
            // resummarise, or the summary a failed run kept) and otherwise
            // the one a fetch of new text already moved aside.
            let previous_summary_json = defined(col(Some(&existing), "summary_json"))
                .or_else(|| defined(col(Some(&existing), "previous_summary_json")))
                .unwrap_or(Value::Null);
            let previous_summary_at = if has_summary {
                col(Some(&existing), "updated_at")
            } else {
                col(Some(&existing), "previous_summary_at")
            };
            persist_from(
                log,
                &existing,
                app_id,
                policy_url,
                SummaryFields {
                    status: "ready",
                    analysis_mode: json!(mode),
                    summary_json: json!(summary.to_string()),
                    previous_summary_json,
                    previous_summary_at,
                    model: json!(config.model),
                    error: None,
                },
                now,
            )?
        }
        Err(message) => {
            log.end_phase(None, Some(message.clone()));
            // With no summary to keep, the row names the model that failed.
            persist_from(
                log,
                &existing,
                app_id,
                policy_url,
                kept_summary(
                    &existing,
                    has_summary,
                    "analysis_error",
                    json!(config.model),
                    message,
                ),
                now,
            )?
        }
    };
    Ok((analysis, FollowUps::default()))
}

/// Who and what a summary is for.
pub(super) struct Subject<'s> {
    pub app_id: &'s str,
    pub app_name: &'s str,
    pub developer: Option<&'s str>,
    pub policy_url: &'s str,
    pub policy_text: &'s str,
    pub content_hash: &'s str,
}

/// `resolvePolicyLengthConfig`: the direct limit and the chunk size.
fn length_limits(config: &AiConfig) -> (usize, usize) {
    if provider_likely_needs_chunking(config.provider, &config.model) {
        (8000, 4000)
    } else {
        (MAX_DIRECT_POLICY_CHARS, MAX_CHUNK_CHARS)
    }
}

/// `buildPolicySummary`.
pub(super) async fn build_policy_summary(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    config: &AiConfig,
    subject: &Subject<'_>,
    guardian: bool,
) -> Result<(Value, &'static str), String> {
    let (max_direct, max_chunk) = length_limits(config);
    let length = js_length(subject.policy_text);
    if length <= max_direct {
        log.note(
            "ai-direct",
            format!("Sending {} chars in a single call.", locale_int(length)),
        );
        let schema = final_summary_schema(guardian);
        let prompt = build_direct_prompt(
            subject.app_name,
            subject.developer,
            subject.policy_url,
            subject.policy_text,
            guardian,
            &mut || ids.nonce(),
        );
        let result = call_ai_json(
            log,
            ids,
            fetcher,
            config,
            &AiCall {
                schema_name: "privacy_policy_summary",
                schema,
                prompt,
                app_id: Some(subject.app_id),
                app_name: Some(subject.app_name),
                phase: Some("direct-summary".to_string()),
                phase_kind: TimeoutPhase::Direct,
            },
        )
        .await?;
        return Ok((normalize_policy_summary(&result), "direct"));
    }

    let chunks = chunk_policy_text(subject.policy_text, max_chunk);
    log.note(
        "ai-chunked",
        format!("Splitting source into {} chunks.", chunks.len()),
    );
    let reusable = if subject.content_hash.is_empty() {
        None
    } else {
        load_reusable_chunk_notes(log, subject.app_id, subject.content_hash, chunks.len())?
    };
    let mut notes: Vec<ChunkNote> = reusable.clone().unwrap_or_default();
    if let Some(reused) = &reusable {
        log.note(
            "chunk-notes-reused",
            format!(
                "Reusing {} stored chunk note{} from a prior run; skipping to merge.",
                reused.len(),
                if reused.len() == 1 { "" } else { "s" }
            ),
        );
    }
    for index in notes.len()..chunks.len() {
        log.start_phase(
            &format!("chunk-{}", index + 1),
            Some(format!(
                "Summarising chunk {} of {}.",
                index + 1,
                chunks.len()
            )),
        );
        let note = summarize_policy_chunk(
            log,
            ids,
            fetcher,
            config,
            subject,
            &chunks[index],
            index + 1,
            chunks.len(),
        )
        .await?;
        log.end_phase(None, None);
        notes.push(note);
        if !subject.content_hash.is_empty() {
            if let Err(e) = persist_chunk_notes(log, subject.app_id, subject.content_hash, &notes) {
                log.fail("chunk-notes-persist-error", e);
            }
        }
    }
    log.start_phase(
        "chunk-merge",
        Some("Merging chunk notes into final summary.".to_string()),
    );
    let schema = final_summary_schema(guardian);
    let prompt = build_merge_prompt(
        subject.app_name,
        subject.developer,
        subject.policy_url,
        &notes,
        chunks.len(),
        guardian,
        &mut || ids.nonce(),
    );
    let result = call_ai_json(
        log,
        ids,
        fetcher,
        config,
        &AiCall {
            schema_name: "privacy_policy_summary_from_chunks",
            schema,
            prompt,
            app_id: Some(subject.app_id),
            app_name: Some(subject.app_name),
            phase: Some("chunk-merge".to_string()),
            phase_kind: TimeoutPhase::Merge,
        },
    )
    .await?;
    log.end_phase(None, None);
    Ok((normalize_policy_summary(&result), "chunked"))
}

/// `summarizePolicyChunk`: the chunk's notes, with a stock sentence where
/// the model left the summary or every highlight empty.
#[allow(clippy::too_many_arguments)]
async fn summarize_policy_chunk(
    log: &mut RunLogger<'_>,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    config: &AiConfig,
    subject: &Subject<'_>,
    chunk_text: &str,
    chunk_index: usize,
    total_chunks: usize,
) -> Result<ChunkNote, String> {
    let schema = chunk_note_schema();
    let prompt = build_chunk_prompt(
        subject.app_name,
        subject.developer,
        subject.policy_url,
        chunk_text,
        chunk_index,
        total_chunks,
        &mut || ids.nonce(),
    );
    let result = call_ai_json(
        log,
        ids,
        fetcher,
        config,
        &AiCall {
            schema_name: "privacy_policy_chunk_note",
            schema,
            prompt,
            app_id: Some(subject.app_id),
            app_name: Some(subject.app_name),
            phase: Some(format!("chunk-{chunk_index}-of-{total_chunks}")),
            phase_kind: TimeoutPhase::Chunk,
        },
    )
    .await?;
    let field = |key: &str| match &result {
        Value::Object(map) => map.get(key),
        _ => None,
    };
    let summary = match clean_sentence(field("summary")) {
        s if s.is_empty() => "This chunk did not add clear privacy-practice details.".to_string(),
        s => s,
    };
    let highlights: Vec<String> = match field("highlights") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| clean_sentence(Some(item)))
            .filter(|s| !s.is_empty())
            .take(6)
            .collect(),
        _ => Vec::new(),
    };
    let highlights = if highlights.is_empty() {
        vec!["No clearly extractable customer-data practice was stated in this chunk.".to_string()]
    } else {
        highlights
    };
    Ok((summary, highlights))
}

/// `persistChunkNotes`.
fn persist_chunk_notes(
    log: &mut RunLogger<'_>,
    app_id: &str,
    content_hash: &str,
    notes: &[ChunkNote],
) -> Result<(), String> {
    let json_notes = Value::Array(
        notes
            .iter()
            .map(|(summary, highlights)| json!({"summary": summary, "highlights": highlights}))
            .collect(),
    );
    log.db()
        .with(|w| {
            w.run(
                PERSIST_CHUNK_NOTES,
                vec![
                    json!(json_notes.to_string()),
                    json!(content_hash),
                    json!(app_id),
                ],
            )
        })
        .map(drop)
}

/// `loadReusableChunkNotes`: the stored notes when they were taken from
/// this very text and cut into as many chunks.
fn load_reusable_chunk_notes(
    log: &mut RunLogger<'_>,
    app_id: &str,
    content_hash: &str,
    expected: usize,
) -> Result<Option<Vec<ChunkNote>>, String> {
    let Some(row) = log.db().with(|w| read_row(w.conn, app_id))? else {
        return Ok(None);
    };
    let stored = row.get("chunk_notes_json").cloned().unwrap_or(Value::Null);
    if !truthy(&stored) || row.get("chunk_notes_hash").and_then(Value::as_str) != Some(content_hash)
    {
        return Ok(None);
    }
    let Some(notes) = parse_stored_chunk_notes(&stored) else {
        return Ok(None);
    };
    if notes.len() != expected {
        return Ok(None);
    }
    Ok(Some(
        notes
            .iter()
            .map(|note| {
                let summary = note["summary"].as_str().unwrap_or_default().to_string();
                let highlights = note["highlights"]
                    .as_array()
                    .map(|hs| {
                        hs.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                (summary, highlights)
            })
            .collect(),
    ))
}

/// `summarizeSamplePrivacyPolicy`: the built-in sample through the same
/// pipeline, logged in memory only, returned with the checklist a person
/// judges the model by.
pub(crate) async fn summarize_sample_privacy_policy(
    db: &mut dyn DbAccess,
    ids: &mut dyn Ids,
    fetcher: &dyn Fetcher,
    clock: &dyn Clock,
    config: &AiConfig,
    guardian: bool,
) -> Result<Value, String> {
    let mut log = RunLogger::detached(db, clock);
    log.start_phase(
        "sample-summary",
        Some("Summarising the built-in sample privacy policy.".to_string()),
    );
    let content_hash = sha256_hex(SAMPLE_POLICY_TEXT);
    let built = build_policy_summary(
        &mut log,
        ids,
        fetcher,
        config,
        &Subject {
            app_id: "__sample_policy_test__",
            app_name: SAMPLE_POLICY_APP_NAME,
            developer: Some(SAMPLE_POLICY_DEVELOPER),
            policy_url: SAMPLE_POLICY_URL,
            policy_text: SAMPLE_POLICY_TEXT,
            content_hash: &content_hash,
        },
        guardian,
    )
    .await;
    match built {
        Ok((summary, mode)) => {
            log.end_phase(Some("Sample summary ready.".to_string()), None);
            Ok(json!({
                "summary": summary,
                "mode": mode,
                "phases": log.phases(),
                "sample": {
                    "appName": SAMPLE_POLICY_APP_NAME,
                    "developer": SAMPLE_POLICY_DEVELOPER,
                    "policyUrl": SAMPLE_POLICY_URL,
                    "policyText": SAMPLE_POLICY_TEXT,
                    "scenario": SAMPLE_POLICY_SCENARIO,
                    "wordCount": count_words(SAMPLE_POLICY_TEXT),
                    "reviewChecklist": SAMPLE_POLICY_REVIEW_CHECKLIST,
                    "expectedSignals": SAMPLE_POLICY_EXPECTED_SIGNALS,
                },
            }))
        }
        Err(e) => {
            log.end_phase(None, Some(e.clone()));
            Err(e)
        }
    }
}

/// `buildPolicySummaryPromptPreview`: what the direct call would send.
pub(crate) fn build_policy_summary_prompt_preview(
    ids: &mut dyn Ids,
    app_name: &str,
    developer: Option<&str>,
    policy_url: &str,
    policy_text: &str,
    guardian: bool,
) -> Value {
    json!({
        "system": POLICY_SYSTEM_PROMPT,
        "user": build_direct_prompt(app_name, developer, policy_url, policy_text, guardian, &mut || ids.nonce()),
        "schema": final_summary_schema(guardian),
    })
}
