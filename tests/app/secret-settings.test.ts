import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import db, { dataDir } from "../../lib/db";
import { getSetting, setSetting } from "../../lib/scheduler";

function storedValue(key: string): string {
  return (
    db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as {
      value: string;
    }
  ).value;
}

test("secret settings are encrypted and legacy plaintext migrates on read", () => {
  const key = "ai_api_key";
  const secret = `secret-${Date.now()}`;
  setSetting(key, secret);

  assert.equal(getSetting(key), secret);
  assert.match(storedValue(key), /^enc:v1:/);
  assert.equal(storedValue(key).includes(secret), false);
  if (process.platform !== "win32" && !process.env.PRIVACYTRACKER_SECRET_KEY) {
    assert.equal(
      fs.statSync(path.join(dataDir, ".secret-key")).mode & 0o777,
      0o600
    );
  }

  const legacy = `legacy-${Date.now()}`;
  db.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(
    legacy,
    key
  );
  assert.equal(getSetting(key), legacy);
  assert.match(storedValue(key), /^enc:v1:/);
  assert.equal(storedValue(key).includes(legacy), false);

  setSetting(key, "");
});
