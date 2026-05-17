import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PRIVACYTRACKER_DATA_DIR ??= mkdtempSync(
  join(tmpdir(), "privacytracker-tests-")
);
process.env.NEXT_PHASE ??= "phase-test";
