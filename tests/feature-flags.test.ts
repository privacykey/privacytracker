import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFlag, type ResolverContext } from '../lib/feature-flags';

function ctx(overrides: ResolverContext['overrides'] = new Map()): ResolverContext {
  return {
    focus: {
      audience: 'self',
      goals: new Set(['understand']),
      aiConfigured: false,
    },
    overrides,
    killSwitchOff: false,
  };
}

test('Apple Configurator onboarding method is desktop-runtime only by default', () => {
  assert.equal(resolveFlag('flag.onboarding.method.configurator', ctx()), 'off');
  assert.equal(
    resolveFlag('flag.onboarding.method.configurator', {
      ...ctx(),
      runtimeEnvironment: 'desktop',
    }),
    'on',
  );
});

test('Apple Configurator onboarding method still honours explicit user override', () => {
  assert.equal(
    resolveFlag(
      'flag.onboarding.method.configurator',
      {
        ...ctx(new Map([['flag.onboarding.method.configurator', 'off'] as const])),
        runtimeEnvironment: 'desktop',
      },
    ),
    'off',
  );
});
