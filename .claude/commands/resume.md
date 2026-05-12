---
description: Resume the active session from .claude/state/session.json
---

You're being asked to resume a session for this repo.

## Step 1 — read state

Read `.claude/state/session.json` from the repo root. If the file
doesn't exist, tell the user "no resumable session — nothing to resume"
and stop.

## Step 2 — summarize where we left off

Output a concise (under ~12 lines) summary in this shape:

```
**Goal:** {current_goal}
**Status:** {status} · branch {branch} · last updated {updated_at}

**Done** ({completed.length}): {last 3 outcomes, one line each}{ if more, append "+ N earlier steps"}
**Pending** ({pending.length}): {one line per item}
**Open questions:** {only those with answer === null}
**Key files:** {top 5 by relevance}
**Recent commits:** {git_commits_in_session, sha + first line of message}
```

If `status === "completed"`, say so explicitly and ask whether the user
wants to start a new goal (don't try to resume work that's already
done).

If `status === "blocked"` and there are unanswered `open_questions`,
surface them at the top and ask for answers before resuming.

## Step 3 — pick up the next pending todo

Only when `status === "in_progress"`:

1. Take the first entry in `pending[]`.
2. Re-read the relevant files in `key_files` so you have current context.
3. Do not re-ask any question that has a non-null answer in
   `open_questions` — apply the stored answer directly.
4. Use `TodoWrite` to mirror the pending list into the in-conversation
   tracker so progress is visible.
5. Continue work.

## Step 4 — keep state current

After every completed todo (in this session or any future one):

1. Move the item from `pending[]` to `completed[]` with an `outcome`
   string, the touched `files`, and a `completed_at` ISO timestamp.
2. Bump `updated_at` to now.
3. Append any new judgment calls to `decisions[]`.
4. Write the result back with the `Write` tool.

After every user clarification, fill the matching `open_questions[].answer`
field (don't delete the question — the rationale is part of the audit
trail).

When the user states a new goal, append the current session to a
`completed` archive section or rotate the file — preserve history, don't
silently overwrite.

The schema is documented in the repo's `CLAUDE.md` under "Session
continuity protocol". Honour it.
