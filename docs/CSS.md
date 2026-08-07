# CSS ownership and the migration out of globals.css

`app/globals.css` reached ~32k lines because every component's styles
landed there. The component-extraction campaign deliberately left it
untouched; this document is the contract for moving styles out now that
the components have homes.

## Format: co-located plain CSS, not CSS Modules

A component's styles live in a plain `.css` file next to it (or next to
its family), imported by the component that owns the classes. This
follows the repo's existing precedent — fourteen components already do
exactly this (`task-list.css`, `review-queue.css`, `device-sync.css`
shared by four components, `onboard-step2.css` shared by two, …) — and
was chosen over CSS Modules deliberately:

- Several stylesheets are legitimately shared by sibling components;
  Modules would force either duplication or awkward composition for those.
- Class names are load-bearing beyond styling here: e2e specs select on
  them, `data-flag-target` highlighting matches them, and the a11y
  shape-toggle rebuilds them with clip-paths. Hashed module classes would
  break all three.
- The goal is smaller ownership boundaries, not a new framework.

## What stays in globals.css, by design

- Design tokens (custom properties) and base element styles.
- Severity and category styling driven by `lib/privacy-meta.ts`
  (`SEVERITY_CONFIG` / `CATEGORY_META`) — used everywhere.
- The `data-a11y-shapes` clip-path rebuilds (documented in AGENTS.md).
- Cross-surface primitives shared by many components: `.modal-overlay` /
  `.modal-card`, `.btn*`, toast, nav, and the settings shell
  (`.settings-section`, `.settings-sidebar*`, `.settings-group-heading`,
  field/checkbox helpers) — a shell class used by 20+ sections is global
  infrastructure, not a component's property.

Everything else — selectors owned by a single component or family —
migrates in small batches, family by family.

## The gate: run the visual net around every batch

Nothing structural or behavioural catches a dropped selector, so every
CSS-moving PR runs `tests/e2e/visual.spec.ts` before and after:

```bash
VISUAL=1 npx playwright test tests/e2e/visual.spec.ts --update-snapshots   # baseline, pre-change
VISUAL=1 npx playwright test tests/e2e/visual.spec.ts                      # must pass, post-change
```

The baselines are local-only and gitignored — they are both
platform-specific (font rendering differs from CI's runners) and app
screenshots, which stay out of the public repo as a matter of policy.
The spec skips entirely without `VISUAL=1`, so CI is unaffected.

One known limit: the net covers the settings routes, onboarding steps 1–2,
dashboard, grid and detail. Selectors that only paint deeper in the
wizard (steps 3–5, the policy-run panel) or in rarer states are not
pixel-covered — when migrating those families, drive the surface manually
once, and keep the moved blocks byte-identical so review can verify the
move by diff.

## Rules for a migration batch

1. Move selector blocks **verbatim** — the PR should be reviewable as
   "cut here, pasted there", with any actual style change in its own
   commit, never mixed into a move.
2. Preserve each family's internal rule order (later-wins ties inside a
   family are real).
3. The importing component is the family's owner; a shared family is
   imported by each sibling that uses it (imports dedupe).
4. Batch small — one family per PR beats one heroic move.
