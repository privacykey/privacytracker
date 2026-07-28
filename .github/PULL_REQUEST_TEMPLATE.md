<!--
Thanks for the contribution. Keep this short — the diff says what
changed, so use the description to say why.
Full guidance: CONTRIBUTING.md
-->

## What and why

<!-- One or two sentences. What problem does this solve? If you found
     something surprising along the way, mention it — that context is
     usually the most valuable part of a PR. -->

## How it was verified

<!-- What you actually ran, and what it said. Delete lines that don't
     apply; add anything else you exercised (a specific flow, a device,
     a locale). "Should work" isn't verification. -->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm lint:i18n` (if any copy or locale keys changed)
- [ ] `pnpm test:e2e` (if any user-facing UI changed)
- [ ] Exercised the change in the running app

## Checklist

- [ ] One coherent change — not several unrelated fixes bundled together
- [ ] New user-facing strings go through `locales/en.json` (and are
      mirrored into the other locales)
- [ ] New interactive UI is reachable and operable by keyboard
- [ ] The a11y gate's known-issue allowlist in `tests/e2e/a11y.spec.ts`
      is still empty — or a new entry names the pending fix that will
      delete it
- [ ] No hand-bumped dependency versions (Renovate owns those)

## Screenshots

<!-- Before/after for any visual change. Include a phone-width shot if
     you touched layout — several past regressions were mobile-only. -->
