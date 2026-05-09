import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diffAccessibility,
  extractAccessibilityFeatures,
  slugifyFeatureTitle,
} from '../lib/accessibility';

test('accessibility parser extracts rich shelf features with descriptions and artwork', () => {
  const features = extractAccessibilityFeatures([{
    data: {
      shelfMapping: {
        accessibilityHeader: {
          seeAllAction: {
            pageData: {
              shelves: [{
                contentType: 'accessibilityFeatures',
                items: [{
                  features: [{
                    title: 'Voice Control',
                    description: 'Use your voice to control the app.',
                    artwork: { template: 'systemimage://voice.control' },
                  }],
                }],
              }],
            },
          },
        },
      },
    },
  }]);

  assert.deepEqual(features, [{
    identifier: 'voice_control',
    title: 'Voice Control',
    description: 'Use your voice to control the app.',
    iconTemplate: 'systemimage://voice.control',
  }]);
});

test('accessibility parser falls back to compact title-only shelf', () => {
  const features = extractAccessibilityFeatures([{
    data: {
      shelfMapping: {
        accessibilityFeatures: {
          items: [{
            features: [
              { title: 'Larger Text' },
              { title: 'Larger Text' },
              { title: 'Sufficient Contrast' },
            ],
          }],
        },
      },
    },
  }]);

  assert.deepEqual(features?.map(feature => feature.identifier), [
    'larger_text',
    'sufficient_contrast',
  ]);
  assert.equal(features?.[0].description, null);
});

test('accessibility parser distinguishes absent shelf from empty declared shelf', () => {
  assert.equal(extractAccessibilityFeatures([{ data: { shelfMapping: {} } }]), null);
  assert.deepEqual(extractAccessibilityFeatures([{
    data: { shelfMapping: { accessibilityHeader: {} } },
  }]), []);
});

test('accessibility diffs report added and removed feature claims', () => {
  const changes = diffAccessibility(
    [{ identifier: 'voiceover', title: 'VoiceOver', description: null, iconTemplate: null }],
    [{ identifier: 'captions', title: 'Captions', description: null, iconTemplate: null }],
  );

  assert.deepEqual(changes.map(change => ({
    type: change.type,
    category: change.category,
    description: change.description,
  })), [
    {
      type: 'added',
      category: 'accessibility',
      description: 'Now supports accessibility feature: "Captions"',
    },
    {
      type: 'removed',
      category: 'accessibility',
      description: 'No longer claims accessibility feature: "VoiceOver"',
    },
  ]);
});

test('accessibility feature slugs are stable for punctuation and spacing', () => {
  assert.equal(slugifyFeatureTitle('Differentiate Without Color Alone'), 'differentiate_without_color_alone');
  assert.equal(slugifyFeatureTitle('  VoiceOver!!!  '), 'voiceover');
});
