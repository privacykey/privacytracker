// Quick standalone verification — compiles lib/backup.ts on the fly and
// asserts the redaction works.
//
// Run from the repo root:
//   node --import tsx scripts/redaction-check.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.PRIVACYTRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'redaction-'));
process.env.NEXT_PHASE = 'phase-test';

const { setSetting, getSetting } = await import('../lib/scheduler.ts');
const { exportBackup, SENSITIVE_SETTING_KEYS, redactSensitiveSettingsRows } = await import('../lib/backup.ts');

const sentinel = 'sk-redaction-DO-NOT-LEAK-' + Date.now();
setSetting('ai_api_key', sentinel);

console.log('Stored ai_api_key reads back as:', getSetting('ai_api_key', '') === sentinel ? 'sentinel ✓' : 'WRONG ✗');

const envelope = exportBackup();
const serialised = JSON.stringify(envelope);
console.log('Envelope serialised, bytes:', serialised.length);
console.log('Sentinel in dump?', serialised.includes(sentinel) ? 'YES (LEAK ✗)' : 'no ✓');

const settings = envelope.tables.app_settings;
console.log('app_settings table present?', !!settings ? 'yes ✓' : 'no ✗');

let redactedOk = true;
for (const key of SENSITIVE_SETTING_KEYS) {
  const row = settings.rows.find(r => r.key === key);
  if (!row) { console.log(`  ${key}: not present (skip)`); continue; }
  const ok = row.value === '';
  console.log(`  ${key}: value=${JSON.stringify(row.value)} ${ok ? '✓' : '✗'}`);
  if (!ok) redactedOk = false;
}

// Also test the helper directly with synthetic rows.
const synthetic = [
  { key: 'ai_api_key', value: 'should-be-scrubbed' },
  { key: 'ai_provider', value: 'openai' },
];
const scrubbed = redactSensitiveSettingsRows(synthetic);
console.log('redactSensitiveSettingsRows direct test:');
console.log('  ai_api_key.value =', JSON.stringify(scrubbed[0].value), scrubbed[0].value === '' ? '✓' : '✗');
console.log('  ai_provider.value =', JSON.stringify(scrubbed[1].value), scrubbed[1].value === 'openai' ? '✓ (preserved)' : '✗');
console.log('  original input mutated?', synthetic[0].value === 'should-be-scrubbed' ? 'no ✓' : 'YES ✗');

if (serialised.includes(sentinel) || !redactedOk) process.exit(1);
process.exit(0);
