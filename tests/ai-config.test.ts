import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_TIMEOUT_MAX_MS,
  AI_TIMEOUT_MIN_MS,
  defaultAiTimeoutMs,
  getAiModelOptions,
  normalizeAiProvider,
  providerLikelyNeedsChunking,
  providerRequiresApiKey,
  providerSupportsApiKey,
  providerUsesChatCompletions,
  resolveAiTimeoutMs,
  resolveDefaultBaseUrl,
  resolveDefaultModel,
} from '../lib/ai-config';

test('AI provider helpers normalise legacy and unknown provider values', () => {
  assert.equal(normalizeAiProvider('openai'), 'openai');
  assert.equal(normalizeAiProvider('ollama'), 'custom');
  assert.equal(normalizeAiProvider('unexpected-provider'), 'disabled');
  assert.equal(normalizeAiProvider(null), 'disabled');
});

test('AI provider defaults describe endpoint, model, key, and transport behavior', () => {
  assert.equal(resolveDefaultBaseUrl('openai'), 'https://api.openai.com/v1');
  assert.equal(resolveDefaultBaseUrl('anthropic'), 'https://api.anthropic.com');
  assert.equal(resolveDefaultBaseUrl('custom'), 'http://127.0.0.1:11434');
  assert.equal(resolveDefaultBaseUrl('disabled'), '');

  assert.equal(resolveDefaultModel('openai'), 'gpt-4.1-mini');
  assert.equal(resolveDefaultModel('anthropic'), 'claude-3-5-haiku-latest');
  assert.equal(resolveDefaultModel('custom'), 'gemma3n:e4b');
  assert.equal(resolveDefaultModel('disabled'), '');

  assert.equal(providerRequiresApiKey('openai'), true);
  assert.equal(providerRequiresApiKey('anthropic'), true);
  assert.equal(providerRequiresApiKey('custom'), false);
  assert.equal(providerSupportsApiKey('disabled'), false);

  assert.equal(providerUsesChatCompletions('openai'), true);
  assert.equal(providerUsesChatCompletions('custom'), true);
  assert.equal(providerUsesChatCompletions('anthropic'), false);
});

test('AI model option lists are scoped by provider', () => {
  assert.deepEqual(getAiModelOptions('disabled'), []);
  assert.ok(getAiModelOptions('openai').some(option => option.value === 'gpt-4.1-mini'));
  assert.ok(getAiModelOptions('anthropic').some(option => option.value === 'claude-sonnet-4-20250514'));
  assert.ok(getAiModelOptions('custom').some(option => option.value === 'llama3.2'));
});

test('AI timeout defaults and overrides account for slow local models', () => {
  assert.equal(providerLikelyNeedsChunking('custom', 'anything'), true);
  assert.equal(providerLikelyNeedsChunking('openai', 'gpt-4.1-mini'), false);
  assert.equal(providerLikelyNeedsChunking('openai', 'qwen2.5:7b'), true);

  assert.equal(defaultAiTimeoutMs('openai', 'gpt-4.1-mini', 'direct'), 90_000);
  assert.equal(defaultAiTimeoutMs('openai', 'gpt-4.1-mini', 'merge'), 120_000);
  assert.equal(defaultAiTimeoutMs('custom', 'gemma3n:e4b', 'chunk'), 180_000);
  assert.equal(defaultAiTimeoutMs('custom', 'gemma3n:e4b', 'merge'), 360_000);

  assert.equal(resolveAiTimeoutMs(undefined, 'openai', 'gpt-4.1-mini', 'direct'), 90_000);
  assert.equal(resolveAiTimeoutMs('55000.9', 'openai', 'gpt-4.1-mini', 'direct'), 55_000);
  assert.equal(resolveAiTimeoutMs('not-a-number', 'openai', 'gpt-4.1-mini', 'direct'), 90_000);
  assert.equal(resolveAiTimeoutMs('1', 'openai', 'gpt-4.1-mini', 'direct'), AI_TIMEOUT_MIN_MS);
  assert.equal(resolveAiTimeoutMs('999999999', 'custom', 'gemma3n:e4b', 'merge'), AI_TIMEOUT_MAX_MS);
});
