import { fixupConfigRules, fixupPluginRules } from '@eslint/compat';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import reactHooks from 'eslint-plugin-react-hooks';

const config = [
  ...fixupConfigRules(nextVitals),
  ...fixupConfigRules(nextTs),
  {
    ignores: [
      '.next/**',
      '.next-test/**',
      '.next-build-check/**',
      '.claude/**',
      'node_modules/**',
      'out/**',
      'build/**',
      'coverage/**',
      'src-tauri/target/**',
      'src-tauri/binaries/**',
      'src-tauri/resources/standalone/**',
      'sessions/**',
      'tools/__pycache__/**',
      'tools/out/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    plugins: {
      'react-hooks': fixupPluginRules(reactHooks),
    },
    rules: {
      // Pragmatic typed API boundaries — keep lint useful without forcing a
      // broad typing refactor.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-this-alias': 'warn',

      // React Compiler / Hooks v6 advisory rules. This codebase doesn't use
      // the React Compiler, so the compiler-hint rules are turned off as
      // pure noise. The rules kept catch real bugs (infinite-loop bait,
      // broken memo deps, stale closures, missing error boundaries). If
      // you ever turn on the React Compiler, flip the disabled ones back
      // to 'warn'.
      'react-hooks/static-components': 'off',
      'react-hooks/use-memo': 'off',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/config': 'off',
      'react-hooks/gating': 'off',
    },
  },
];

export default config;
