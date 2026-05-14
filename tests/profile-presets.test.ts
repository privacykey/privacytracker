import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PROFILE,
  PROFILE_CATEGORY_KEYS,
  PROFILE_PRESETS,
  PROFILE_PRESET_KEYS,
  PROFILE_PRESET_META,
  PROFILE_TIERS,
  describePresetTransition,
  matchPreset,
  type PrivacyProfile,
} from '../lib/privacy-profile';

// Each named preset is a complete profile (all 14 categories) — picking
// a preset replaces the user's profile wholesale, so any sparse preset
// would leave dangling "no preference" rows that wouldn't round-trip
// through matchPreset.
test('every preset covers every privacy category with a valid tier', () => {
  for (const presetKey of PROFILE_PRESET_KEYS) {
    const preset = PROFILE_PRESETS[presetKey];
    const presetCats = Object.keys(preset);
    assert.equal(
      presetCats.length,
      PROFILE_CATEGORY_KEYS.length,
      `preset "${presetKey}" should cover all ${PROFILE_CATEGORY_KEYS.length} categories (got ${presetCats.length})`,
    );
    for (const cat of PROFILE_CATEGORY_KEYS) {
      const tier = preset[cat];
      assert.ok(tier, `preset "${presetKey}" missing category ${cat}`);
      assert.ok(
        (PROFILE_TIERS as readonly string[]).includes(tier),
        `preset "${presetKey}" has invalid tier "${tier}" for ${cat}`,
      );
    }
  }
});

test('balanced preset matches the historical DEFAULT_PROFILE byte-for-byte', () => {
  // We promise users that "Balanced" is the same shape they've always
  // gotten by default — if this changes we must announce it. Locking
  // the equality protects us from drift when DEFAULT_PROFILE is edited.
  assert.deepEqual(PROFILE_PRESETS.balanced, DEFAULT_PROFILE);
});

test('every preset has matching meta with label/description/icon/severityCls', () => {
  for (const presetKey of PROFILE_PRESET_KEYS) {
    const meta = PROFILE_PRESET_META[presetKey];
    assert.ok(meta, `missing PROFILE_PRESET_META entry for ${presetKey}`);
    assert.equal(meta.key, presetKey);
    assert.ok(meta.label.length > 0, `${presetKey} label is empty`);
    assert.ok(meta.description.length > 0, `${presetKey} description is empty`);
    assert.ok(meta.icon.length > 0, `${presetKey} icon is empty`);
    assert.ok(
      ['severity-none', 'severity-unlinked', 'severity-linked', 'severity-track'].includes(
        meta.severityCls,
      ),
      `${presetKey} severityCls "${meta.severityCls}" is not a known severity class`,
    );
  }
});

test('matchPreset round-trips every named preset', () => {
  // Cloning the preset before passing it in mirrors how the editor
  // applies presets (spread copy via onChange). Reference-equality
  // mistakes would slip through without this.
  for (const presetKey of PROFILE_PRESET_KEYS) {
    const fresh = { ...PROFILE_PRESETS[presetKey] };
    assert.equal(matchPreset(fresh), presetKey, `expected matchPreset to return "${presetKey}"`);
  }
});

test('matchPreset returns null for empty, sparse, and customised profiles', () => {
  assert.equal(matchPreset(null), null, 'null profile should not match a preset');
  assert.equal(matchPreset(undefined), null, 'undefined profile should not match a preset');
  assert.equal(matchPreset({}), null, 'empty profile should not match a preset');

  // Sparse profile (Strict minus one category) is no longer a complete
  // preset and must report as custom.
  const sparseStrict: PrivacyProfile = { ...PROFILE_PRESETS.strict };
  delete sparseStrict.OTHER;
  assert.equal(matchPreset(sparseStrict), null, 'sparse profile should not match a preset');

  // Single-category drift — user picked Balanced, then nudged LOCATION
  // upward. Highlight should clear.
  const balancedThenEdited: PrivacyProfile = {
    ...PROFILE_PRESETS.balanced,
    LOCATION: 'tracking',
  };
  assert.equal(
    matchPreset(balancedThenEdited),
    null,
    'a single edited category should drop the preset highlight',
  );
});

test('anti_tracking preset sets every category to "linked"', () => {
  // Self-documenting check — "anti-tracking only" is meaningful only if
  // every category sits at exactly "linked", so any future edit that
  // accidentally shifts a category up or down breaks the contract.
  for (const cat of PROFILE_CATEGORY_KEYS) {
    assert.equal(
      PROFILE_PRESETS.anti_tracking[cat],
      'linked',
      `anti_tracking should keep ${cat} at "linked" so only third-party tracking flags`,
    );
  }
});

// --- describePresetTransition -------------------------------------------

test('describePresetTransition: null → null returns null (nothing to log)', () => {
  assert.equal(describePresetTransition(null, null), null);
  assert.equal(describePresetTransition(undefined, undefined), null);
  assert.equal(describePresetTransition({}, {}), null);
  assert.equal(describePresetTransition({}, null), null);
});

test('describePresetTransition: null → preset reports "changed to {Label}"', () => {
  const result = describePresetTransition(null, PROFILE_PRESETS.strict);
  assert.ok(result, 'expected a non-null transition');
  assert.equal(result.summary, 'Privacy profile changed to Strict');
  assert.deepEqual(result.detail, { from: null, to: 'strict' });
});

test('describePresetTransition: preset → same preset returns null (idempotent re-save)', () => {
  // The editor debounces saves; the same preset can be PUT twice in a
  // row, and the second save shouldn't generate a duplicate activity row.
  const fresh = { ...PROFILE_PRESETS.balanced };
  assert.equal(describePresetTransition(PROFILE_PRESETS.balanced, fresh), null);
});

test('describePresetTransition: preset → different preset reports the new label', () => {
  const result = describePresetTransition(
    PROFILE_PRESETS.balanced,
    PROFILE_PRESETS.anti_tracking,
  );
  assert.ok(result);
  assert.equal(result.summary, 'Privacy profile changed to Anti-tracking only');
  assert.deepEqual(result.detail, { from: 'balanced', to: 'anti_tracking' });
});

test('describePresetTransition: preset → null reports "cleared" with the previous preset captured', () => {
  const result = describePresetTransition(PROFILE_PRESETS.strict, null);
  assert.ok(result);
  assert.equal(result.summary, 'Privacy profile cleared');
  assert.deepEqual(result.detail, { from: 'strict', to: null, cleared: true });

  // Same outcome when the new profile is an empty object instead of null.
  const result2 = describePresetTransition(PROFILE_PRESETS.strict, {});
  assert.ok(result2);
  assert.equal(result2.detail.cleared, true);
});

test('describePresetTransition: preset → custom edit returns null (custom is not a preset)', () => {
  // User clicks Strict, then nudges LOCATION to 'tracking'. The new
  // profile no longer matches any preset; we don't log a transition
  // for the per-row tweak — only preset-boundary crossings count.
  const customised: PrivacyProfile = {
    ...PROFILE_PRESETS.strict,
    LOCATION: 'tracking',
  };
  assert.equal(describePresetTransition(PROFILE_PRESETS.strict, customised), null);
});

test('describePresetTransition: custom → custom returns null (no boundary crossed)', () => {
  const customA: PrivacyProfile = { LOCATION: 'tracking', CONTACT_INFO: 'tracking' };
  const customB: PrivacyProfile = { LOCATION: 'linked', CONTACT_INFO: 'tracking' };
  assert.equal(describePresetTransition(customA, customB), null);
});

test('describePresetTransition: custom → preset still fires (lands on a known preset)', () => {
  // Even when the previous state didn't match any preset, landing on
  // one is a meaningful transition. matchPreset(custom) is null, so
  // `from` is null in the detail blob; that's expected.
  const customA: PrivacyProfile = { LOCATION: 'tracking' };
  const result = describePresetTransition(customA, PROFILE_PRESETS.permissive);
  assert.ok(result);
  assert.equal(result.summary, 'Privacy profile changed to Permissive');
  assert.equal(result.detail.from, null);
  assert.equal(result.detail.to, 'permissive');
});

test('strict and permissive presets sit at opposite ends of the strictness axis', () => {
  // Strict should never be more permissive than Permissive on any
  // category (strictness rank: not_collected < not_linked < linked < tracking).
  // Locking this invariant catches preset edits that would let a
  // "permissive" category secretly become stricter than the "strict" one.
  const tierRank: Record<string, number> = {
    not_collected: 0,
    not_linked: 1,
    linked: 2,
    tracking: 3,
  };
  for (const cat of PROFILE_CATEGORY_KEYS) {
    const strictTier = PROFILE_PRESETS.strict[cat];
    const permissiveTier = PROFILE_PRESETS.permissive[cat];
    assert.ok(strictTier && permissiveTier);
    assert.ok(
      tierRank[strictTier] <= tierRank[permissiveTier],
      `Strict for ${cat} (${strictTier}) is more permissive than Permissive (${permissiveTier})`,
    );
  }
});
