import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMPORT_ROWS,
  extractAppNamesFromOcr,
  parseImportedAppRows,
  sanitizeAppNameInput,
  sanitizeNamesList,
} from '../lib/app-import';

test('parseImportedAppRows detects app and developer columns in CSV exports', () => {
  const parsed = parseImportedAppRows(
    [
      'UDID,Application Name,Vendor,Version',
      'device-1,"Signal, Private Messenger","Signal Messenger, LLC",7.12',
      'device-1,Family Web Clip,,',
    ].join('\n'),
  );

  assert.equal(parsed.totalRowsInSource, 2);
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.rows, [
    {
      name: 'Signal, Private Messenger',
      developer: 'Signal Messenger, LLC',
    },
    {
      name: 'Family Web Clip',
      likelyWebClip: true,
    },
  ]);
});

test('sanitizeNamesList dedupes, trims, and caps unrealistic paste bombs', () => {
  const source = [
    '  Instagram  ',
    'Instagram',
    '   ',
    ...Array.from({ length: MAX_IMPORT_ROWS + 20 }, (_, i) => `App ${i}`),
  ];

  const result = sanitizeNamesList(source);

  assert.equal(result[0], 'Instagram');
  assert.equal(result.length, MAX_IMPORT_ROWS);
  assert.equal(new Set(result).size, result.length);
});

test('sanitizeAppNameInput drops OCR chrome and normalises whitespace', () => {
  assert.equal(sanitizeAppNameInput('  WhatsApp   Messenger  '), 'WhatsApp Messenger');
  assert.deepEqual(extractAppNamesFromOcr('Documents & Data\nWhatsApp Messenger'), [
    'WhatsApp Messenger',
  ]);
});
