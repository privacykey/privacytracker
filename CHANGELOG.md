# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries for `v0.1.0` – `v0.1.2` were written retrospectively from the
[GitHub release notes](https://github.com/privacykey/privacytracker/releases);
they summarise each release rather than listing every merged pull request.
Going forward, changes are recorded here as they land.

## [Unreleased]

### Security

- Refresh the Docker and desktop Node runtime to 24.20.0, require patched Alpine TLS libraries, remove unused package managers from the runtime image, and apply compatible JavaScript/Rust dependency patches. Scan the final image in CI and track desktop runtime/scanner pins with Renovate.

### Added

- Canned sample data now populates every app-detail surface: each demo app
  gets its hand-written AI policy summary stored as a real, ready analysis
  (lens grid, highlights, and source preview render without any AI provider),
  declared accessibility features on the Accessibility tab, and — for
  Instagram — a policy-change history that lights up the recent-change banner
  and the rating-shift strip.
- The app-detail axe gate now also scans the Accessibility, AI Policy, and
  Change History tabs (activated and populated), and the app-detail E2E spec
  covers the change-review panel, the privacy-label accordion toggle, and all
  three tabs.
- Blocking accessibility gate in CI: axe-core scans of the welcome screen,
  onboarding import flow, dashboard, app detail, and mobile navigation, plus
  keyboard-only coverage of the onboarding path.
- Community health documentation — contributing guide, code of conduct,
  support guide, pull-request template, and code owners.
- `pnpm screenshots` — captures a consistent set of UI screenshots from
  the built-in demo fixture, for docs and release notes.
- A `justfile` collecting the common workflows — `just --list` shows the
  set, covering the dev loop, the desktop (Tauri) build, Docker, and the
  verification suites.

### Changed

- **Settings is now four pages instead of one.** Your preferences, sync,
  policies and admin each get their own address
  (`/dashboard/settings/you`, `/sync`, `/policies`, `/admin`), so a page
  loads only what it needs and you can link someone straight to the part
  you mean. Existing links and bookmarks — including the ones in
  notifications — still land in the right place.

- **First-run experience.** Per-feature toggles moved behind an "Advanced"
  disclosure, illustrated goal cards shrunk on phones, and the primary action
  pinned to a sticky footer so it stays reachable. AI summaries now default to
  **Disabled** instead of preselecting a provider, and a stored "disabled"
  choice is honoured on reload. "Save & generate" stays disabled until the
  provider's fields validate. New users now get exactly one post-onboarding
  guide — the task checklist — instead of a checklist plus a coachmark tour
  pointing at it.
- Import candidate selection is now a native radio group: keyboard-operable
  with arrow keys, and announced correctly by screen readers.

### Fixed

- The activity log's type filter works for every event type again. It
  validated the requested type against a list that had fallen eight
  entries behind — so filtering by newer events (privacy-profile preset
  changes, verdicts, migrations, health checks) silently returned the
  *unfiltered* feed instead.
- The Stats page's policy radar no longer reshuffles which six apps it
  shows between visits: when several apps share the same last-synced
  time (which every bulk sync produces), the selection previously fell
  back to database scan order.
- Light-theme colour contrast on the app-detail page now meets WCAG AA:
  not-declared accessibility rows no longer dim their text below the
  threshold, the "Declared by developer" tag and the preference-key legend
  use theme-aware colours, the AI-policy note boxes no longer render dark
  navy in light mode, and the change-history chart's +N/−N counters use the
  theme palette instead of fixed chart-band colours.
- **Failed update checks now back off** instead of retrying forever. An
  installation with no internet access used to attempt a connection to
  GitHub — and wait out its timeout — every time anything asked whether an
  update was available. Consecutive failures now widen the gap between
  attempts (15 minutes, doubling, up to a day). Checking manually still
  makes a real attempt straight away.
- **The SQLite database is now private by default** — `0700` on the data
  directory, `0600` on the database and its write-ahead-log files. Existing
  installations are tightened automatically on their next start. The file
  holds your full app inventory, your notes, and (for now) any configured AI
  provider key.
- Accessible names restored for the icon-only home and "Add Apps" links in the
  compact navigation bar.
- Expandable section headers no longer nest their info-tooltip button inside
  the toggle, and the collapsed notes sidebar no longer keeps invisible
  controls in the tab order.
- The app-name entry field has a real label rather than only a placeholder.
- Colour contrast now meets WCAG AA across the interface: link and secondary
  text colours, the accent blue in light mode, and the navigation drawer were
  all below the 4.5:1 threshold in places.
- Nested panels — activity-log rows, the developer tools cards, and
  import-history banners — now have visible backgrounds. They were styled
  against `--surface-1/2/3` and `--border-1/2` design tokens that were never
  actually defined, so they rendered transparent. Defining those tokens for
  light, dark, high-contrast and reduce-transparency modes also clears the
  last dark-only boxes on the app-detail policy blocks (the scrollable source
  and trace wells) and in the Live Text illustration, which drew a dark phone
  frame in the light theme.

### Security

- Documented in the README that a configured AI provider key is stored in
  plaintext in the local database. Moving desktop keys into the OS keychain is
  planned.

## [0.1.2] — 2026-06-12

### Added

- Animated onboarding purpose cards and dashboard vignettes.
- Periodic health check with non-destructive self-heal for long-running
  instances.
- Read-only deployment mode for shared or kiosk installs.

### Changed

- Privacy-label icons and ordering aligned with Apple's own presentation.
- Full internationalisation sweep — the interface is translator-ready and
  round-trips through Crowdin.
- Onboarding hardening across the four import paths.

## [0.1.1] — 2026-05-20

### Fixed

- **Launch-time freeze affecting every copy of v0.1.0.** The bundled Node
  helper exited immediately with `MODULE_NOT_FOUND` for `@swc/helpers`,
  leaving an unresponsive window. The packaging step had dereferenced pnpm's
  symlinked `node_modules` layout, moving `@swc/helpers` out of Node's
  resolution path; it now preserves those relative symlinks verbatim through
  both staging and the release tarball.

  The auto-updater runs *after* the Node helper boots, so it never fired on
  v0.1.0 — anyone on that version had to install v0.1.1 manually. Every
  install from v0.1.1 onward self-updates normally.

## [0.1.0] — 2026-05-18

Initial beta release, available as a macOS app, a Docker image, or a plain
Next.js app.

### Added

- App Store privacy-label tracking with change detection over time.
- Historical back-fill to Q1 2021 via the Wayback Machine.
- Focus-tailored dashboard adapting to who the device belongs to (yourself, a
  loved one, or someone you support) and what you want from it.
- Four onboarding import paths: typed names, CSV/TXT upload, Apple
  Configurator on desktop, and screenshot OCR.
- Changelog timelines, privacy heatmap, per-app severity strips, an editable
  home-card layout, and exportable audit bundles.
- AI-generated privacy-policy summaries with a bring-your-own provider model.
- Background sync with a notifications bell, and crash-safe resume across the
  live, Wayback, and privacy-policy jobs.

[Unreleased]: https://github.com/privacykey/privacytracker/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/privacykey/privacytracker/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/privacykey/privacytracker/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/privacykey/privacytracker/releases/tag/v0.1.0
