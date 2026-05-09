import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizePolicyUrl,
  validateAppStoreUrl,
  validateExternalUrl,
} from '../lib/security';

test('validateAppStoreUrl only accepts App Store hosts with an Apple id segment', () => {
  assert.equal(validateAppStoreUrl('https://apps.apple.com/us/app/example/id123456789').ok, true);
  assert.equal(validateAppStoreUrl('https://itunes.apple.com/app/example/id123456789').ok, true);
  assert.equal(validateAppStoreUrl('https://apps.apple.com/us/app/example').ok, false);
  assert.equal(validateAppStoreUrl('https://example.com/us/app/example/id123456789').ok, false);
});

test('validateExternalUrl blocks private and non-http targets by default', () => {
  assert.equal(validateExternalUrl('javascript:alert(1)').ok, false);
  assert.equal(validateExternalUrl('file:///etc/passwd').ok, false);
  assert.equal(validateExternalUrl('http://localhost:3000').ok, false);
  assert.equal(validateExternalUrl('http://169.254.169.254/latest/meta-data').ok, false);
});

test('sanitizePolicyUrl persists only safe http(s) URLs', () => {
  assert.equal(sanitizePolicyUrl('https://example.com/privacy'), 'https://example.com/privacy');
  assert.equal(sanitizePolicyUrl('javascript:alert(1)'), '');
  assert.equal(sanitizePolicyUrl('http://127.0.0.1/privacy'), '');
});
