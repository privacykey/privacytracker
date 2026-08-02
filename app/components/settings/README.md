# Settings section components

`SettingsView.tsx` grew to ~11.6k lines rendering 18 sections from a single
component. This directory is where those sections move, one at a time.

## The extraction contract

**`SettingsView` stays the map.** It keeps the flag gates and the section
order, so you can still read one file to answer "what sections exist and
when do they show?". A section component renders the card; it does not
decide whether the card exists.

```tsx
{settingsAdminExportOn && <ExportDataSection auditPdfOn={…} />}
```

**Each section owns its own `useTranslations`.** Don't drill translator
functions down as props — the parent had 40+ of them and passing them
around just moves the problem. Call `useTranslations` in the component
that renders the strings.

**Keep the anchor id and class names byte-identical.** `id="language"`,
`className="settings-section"` and friends are load-bearing:

- `SettingsSidebar` links to `#<id>`, and `tests/e2e/settings-sections.spec.ts`
  asserts every advertised section resolves to a real element
- `/privacy-policy` deep-links to `#ai-summaries`, and the AI timeout copy
  to `#ai-timeouts` — a cross-page contract
- `app/globals.css` styles by class, and the stylesheet is not being
  touched in the same pass

**Section-level gates stay in `SettingsView`; gates *inside* a card do
not.** The rule above is about whether a card exists. Which sub-blocks a
card shows is the card's own business, so a section may call `useFlag`
itself for those. `DeveloperSection` is the worked example: SettingsView
keeps `flag.devopts.visible`, while the eight flags controlling its four
inner panels are resolved by the panels that own them. Drilling those
down would have meant eight boolean props that no reader could match back
to a flag key.

**State that only one section touches can move with it.** Props are the
default, but a subsystem read by exactly one card is better off owning
itself. The activity log — ~14 state values, 6 mirror refs, two fetchers
and four effects — became `lib/use-activity-log.ts`, and
`ActivityLogPanel` takes a single prop as a result. The test is whether
anything *outside* the section reads the state: `debugLogging` looked
equally local but round-trips through the AI settings blob, so it stayed
in SettingsView and is passed down.

**Props are the plumbing.** There is no context or store here, and adding
one would be the wrong trade — of 98 state declarations in the original
component, 81 were used by a single section. Two things are genuinely
shared and are passed as props where needed:

| Prop | What it is |
| --- | --- |
| `showToast(msg)` | The existing one-line helper in `SettingsView`. The `toast` state itself is read in exactly one place (`<Toast>`), so only the setter travels. |
| `status` / `loadStatus` | The fetched `SyncStatus` blob, written once by `loadStatus()` and read by the sync-related sections. |

## Verifying an extraction

`pnpm test:e2e tests/e2e/settings-sections.spec.ts` is the net: it checks
every sidebar-advertised section still renders with content and a heading,
that the page mounts with no console errors or 5xx, and that the
documented deep-links resolve. It reads the section list from the rendered
sidebar, so it needs no updating as sections move.

Typecheck alone will not catch a section that silently stops rendering —
that is exactly the failure mode this directory's refactor risks, and why
the net landed first.

It will not catch a **wrong translation namespace** either. A section that
moves out has to re-declare its `useTranslations` calls, and
`useTranslations("settings.dev_options.ai_debug_log")` typechecks just as
happily as the correct `…ai_debug`. Three of them were wrong on the first
attempt at DeveloperSection. Grep the namespace out of the original
declaration rather than inferring it from the section name, and confirm
every key resolves against `locales/en.json` before trusting a green
typecheck.

For a pass that claims to be a pure move, the stronger check is to render
the section before and after and diff the HTML — see the
`refactor(settings): extract Developer Options` commit message for the
shape of that check.
