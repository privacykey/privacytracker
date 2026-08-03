# Onboarding wizard components

`OnboardWizard.tsx` is ~8.6k lines: five steps of markup over one large
state machine. This directory is where its pieces move.

## Why this can't copy the settings split

`../settings/` worked by moving one section at a time with explicit
props, because of 98 state declarations there, 81 were read by a single
section. The wizard is the opposite: its state is genuinely one machine.
Counting the component-scope bindings each step's JSX touches:

| Step | Lines | Bindings referenced |
| --- | --- | --- |
| 1 — choose method | 345 | 32 |
| 2 — enter apps / search | 1,136 | 72 |
| 3 — review matches | 1,181 | 53 |
| 4 — import progress | 632 | 39 |

A component taking 72 props is not an improvement over the inline JSX, so
the step extractions have to follow the `ImportHistorySection` /
`AiSummariesSection` shape instead: hoist the machine into a hook, then
pass the hook's return value down as **one** object prop. The hook lands
first with the JSX untouched, so each half can be reviewed on its own.

## What's here now

The four components that were already factored at the bottom of
`OnboardWizard.tsx` as module-level functions with explicit props. They
needed no redesign — only a file each:

- `SearchResultBlock` — one search result and its candidate alternatives
- `UnavailableRowEditor` — inline retry editor for a no-match row
- `PolicyRunPanel` / `PolicyPhaseCell` — progress for the optional
  policy-summary run

## Verifying an extraction

Unlike settings, this flow has a **behavioural** net rather than a
structural one, and it is the better tool here:

- `tests/e2e/onboard-import.spec.ts` — 9 tests walking method → search →
  match → import, including ambiguous matches, no-match triage, CSV
  upload, a 401 security gate, and retrying unmatched names
- `tests/e2e/onboarding-keyboard.spec.ts` — keyboard-only paths through
  the same steps, which is what pins `SearchResultBlock`'s radiogroup
- `tests/e2e/onboarding-personas.spec.ts` — first-run acceptance across
  the five audiences
- `tests/e2e/onboarding-clock.spec.ts`, `onboarding-bulk-import-perf.spec.ts`
  — full flow to completion, and the rate-limit drain
- `tests/e2e/a11y.spec.ts` — axe scan of the text-entry and match steps

Those drive the real components, so they catch a broken extraction that a
static HTML diff would miss.

Two things they will **not** catch, both of which have bitten this
refactor already:

- **A wrong `useTranslations` namespace.** It typechecks. Resolve every
  key against `locales/en.json` after moving a component — that check has
  caught three wrong namespaces so far.
- **Hardcoded English that changes file.** `tests/app/i18n-text-literals.test.ts`
  keys its baseline on path, so moved-but-untranslated text reads as new
  debt. Regenerate the baseline (`UPDATE_I18N_TEXT_BASELINE=1`) rather
  than adding an `i18n-exempt` marker, so it stays recorded.
