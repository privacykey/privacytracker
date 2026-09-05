import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PRIVACYTRACKER_DATA_DIR ??= mkdtempSync(
  join(tmpdir(), "privacytracker-tests-")
);
process.env.NEXT_PHASE ??= "phase-test";
process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS ??= "1";

// Tests explicitly model a loopback launcher; network tests override this.
process.env.PRIVACYTRACKER_BIND_HOST ??= "127.0.0.1";
