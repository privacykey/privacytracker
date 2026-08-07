# App Detail section components

`AppDetailView.tsx` grew to ~4.7k lines rendering the whole `/apps/[id]`
surface from one file. This directory is where its sections move. The
first extraction (the AI Policy family, ~1.7k lines) brought the file to
~3.0k; the change-review and label/accessibility families follow the same
contract.

## Which extraction shape, and why

The settings split used explicit per-section props (81 of its 98 state
declarations were read by a single section); the onboarding split used
one hook + a single object prop (its state was one machine, 32–72
bindings per step). AppDetailView needed **neither redesign**: its
sub-surfaces were *already* module-scope components with explicit props
inside the same file — `PolicySummaryPanel`, `ChangeReviewPanel`,
`PrivacyTypeSection`, `AccessibilityPanel`, `WhatsNewSection` and the
policy satellites. Measured against the two precedents this is the
"already factored at the bottom of the file" case from
`../onboard/README.md`: no prop redesign, only a file each.

What stays in `AppDetailView.tsx` is the shell that genuinely shares
state: the hero (whose ~22 component-scope bindings — sync/delete/menu/
back-link machinery — would make a poor prop list), the ARIA tablist,
the flag gates, and the modals. Like `SettingsView`, **the shell stays
the map**: one file still answers "what sections exist and when do they
show?".

## The extraction contract

Same rules as `../settings/README.md`, restated where they differ:

- **Verbatim moves.** A component moves with its markup byte-identical —
  class names, ids, aria wiring. `PrivacyTypeSection`'s accordion header
  carries deliberate a11y semantics (real `<button>` with
  `aria-expanded`/`aria-controls`, `InfoTooltip` as a *sibling*, never a
  descendant — the axe `nested-interactive` fix). Do not restructure it
  in passing.
- **Each component owns its `useTranslations`.** Grep the namespace from
  the original declaration; never infer it from the component name, and
  resolve every key against `locales/en.json` after the move — a wrong
  namespace typechecks fine. (`app_detail.policy_meta` vs
  `app_detail.policy_log` vs `app_detail.policy_run` all exist.)
- **Shared client types live in `types.ts`** — `App`, `PrivacyType`,
  `Category`, `AccessibilityFeatureProp`, `RecentPolicyChangeHint`.
  These deliberately mirror server shapes rather than importing them,
  so the client bundle never drags `better-sqlite3` in via `lib/`.
  `DetailFlagState` stays in `AppDetailView.tsx` (the server page
  imports it from there).
- **Flag gates stay in the shell.** The panel-level flags
  (`flag.detail.policy.*` etc.) thread through as the `flags` prop the
  components already had; whether a tab exists at all is the shell's
  business.
- **Helpers move with their only consumer; shared helpers get a named
  module.** `RATING_WEIGHT` + `orderLensesBySeverity` + `diffLensRatings`
  are shared by the panel and the change strip → `lens-ratings.ts`.
  Private helpers (`describePolicyPhase`, `hostnameOf`,
  `getPolicyStatusMessage`) stay unexported in the file that uses them.

## What's here now

The AI Policy tab family:

- `PolicySummaryPanel.tsx` — the tab's top-level component (the panel
  head: fetch/regenerate machinery, meta pills, status, lens grid) plus
  its private helpers.
- Satellites it composes, one file each: `PolicyRecentChangeBanner`,
  `PolicyFallbackReferences` (with the ToS;DR / PrivacySpy link
  builder), `PolicyRunLogStrip`, `PolicyPreviewBlock`,
  `AiSummaryDisclaimer`, `PolicyChunkNotesBlock`, `PolicyChangeStrip`.
- `lens-ratings.ts` — severity ordering + previous/current rating diff.
- `types.ts` — the shared client types above.

## Verifying an extraction

Three nets, all landed before the first move (see the
`test(app-detail)` PR that seeded them):

1. **DOM byte-diff** — the strongest check for a pure move. Render the
   populated page before and after (canned seed + Strict privacy profile
   + saved a11y profile), capture `outerHTML` of the page container and
   each tab panel, normalise known nondeterminism (React `«id»` attrs,
   relative timestamps, per-seed snapshot UUIDs, ECharts instance
   stamps), and require identical bytes.
2. **Behavioural + axe** — `tests/e2e/app-detail.spec.ts` walks every
   tab populated; `tests/e2e/a11y.spec.ts` scans all four tab surfaces.
   The empty-fixture trap is real: before the canned seeder wrote policy
   analyses and accessibility features, the policy tab rendered its
   empty state in every spec, and a move verified against that would
   have proven nothing.
3. **Pixel net** — `VISUAL=1` (`just visual`), local-only, one shot per
   tab. Baseline immediately before the change, verify after. Known
   noise floor: unrelated surfaces can jiggle 1–2px across *builds*
   (e.g. a filter pill's edge anti-aliasing on the apps grid) — inspect
   any failure's diff bbox before treating it as signal or rebaselining.
