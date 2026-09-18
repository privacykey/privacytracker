import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const worker = fileURLToPath(
  new URL("../helpers/open-db-worker.ts", import.meta.url)
);

function boot(dir: string) {
  execFileSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", worker],
    {
      env: {
        ...process.env,
        PRIVACYTRACKER_DATA_DIR: dir,
        NEXT_PHASE: "phase-test",
      },
      timeout: 30_000,
    }
  );
}

// Audit-bundle imports stored status 'ok', which is not an analysis status,
// so every imported row read back as 'analysis_error' and the AI Policy tab
// reported a failed AI run that never happened. Opening the database gives
// those rows the status the importer writes now.
test("opening the database repairs policy analyses an import stored as 'ok'", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "privacytracker-policy-status-"));
  try {
    boot(dir);

    const file = path.join(dir, "privacy.db");
    const seed = new Database(file);
    const app = seed.prepare(
      "INSERT INTO apps (id, name, url, lastSynced) VALUES (?, ?, ?, 0)"
    );
    const analysis = seed.prepare(
      `INSERT INTO privacy_policy_analyses
         (app_id, policy_url, status, source_text, analysis_mode,
          summary_json, model, updated_at)
       VALUES (?, 'https://example.com/privacy', ?, ?, ?, ?, ?, 0)`
    );
    for (const id of ["summary", "excerpt", "failed"]) {
      app.run(id, id, `https://apps.apple.com/us/app/${id}/id1`);
    }
    analysis.run(
      "summary",
      "ok",
      "policy text",
      "imported",
      '{"overview":"x"}',
      "imported"
    );
    analysis.run("excerpt", "ok", "policy text", "imported", null, "imported");
    // A real status is left alone, summary or not.
    analysis.run(
      "failed",
      "fetch_error",
      "policy text",
      "direct",
      '{"overview":"x"}',
      "gpt"
    );
    seed.close();

    boot(dir);

    const check = new Database(file, { readonly: true });
    const rows = check
      .prepare(
        "SELECT app_id, status FROM privacy_policy_analyses ORDER BY app_id"
      )
      .all() as { app_id: string; status: string }[];
    check.close();
    assert.deepEqual(rows, [
      { app_id: "excerpt", status: "source_ready" },
      { app_id: "failed", status: "fetch_error" },
      { app_id: "summary", status: "ready" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
