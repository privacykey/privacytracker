# Contributing to privacytracker

Thanks for taking the time. This file covers the practical stuff: how to
get the app running, what has to pass before a pull request can land, and
the conventions that are easy to miss.

Deep architecture notes live in **[AGENTS.md](AGENTS.md)** — the single
canonical guide to how the scraper, feature flags, background jobs, and
database migrations fit together. It's written for AI coding agents but
reads perfectly well as developer documentation. Skim it before a
non-trivial change; it will save you an afternoon.

## Prerequisites

- **Node 24+ and <27** (see `engines` in `package.json`)
- **pnpm 11** — the repo pins `packageManager` and ships a
  `pnpm-lock.yaml`. `npm` mostly works but is unsupported and risks
  lockfile drift.
- **Rust stable** — only if you're touching the Tauri desktop shell
  (`src-tauri/`).

## Getting started

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

The app creates its SQLite database at `data/privacy.db` on first run and
restricts it to your user account (`0700` on the directory, `0600` on the
files). No account, no server, no network calls beyond the App Store and
whichever AI provider you configure.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server on :3000 |
| `pnpm build` / `pnpm start` | Production build / serve it |
| `pnpm lint` | Ultracite (Biome) — lint **and** format check |
| `pnpm lint:fix` | Auto-fix the safe rules |
| `pnpm typecheck` | TypeScript, no emit |
| `pnpm test` | Focused `node:test` suite |
| `pnpm test:e2e` | Playwright browser suite |
| `pnpm lint:i18n` | Locale key parity against `en.json` |
| `pnpm test:tauri` | Rust helper tests |
| `pnpm screenshots` | Capture UI screenshots from the demo fixture (see the script header for the server it expects) |

## Before you open a pull request

Run these four. CI runs them too, and they're much faster locally:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm lint:i18n
```

If you touched anything user-facing, also run the browser suite:

```bash
pnpm test:e2e
```

> **Port gotcha:** Playwright reuses whatever is already listening on
> :3000 — including a stale `pnpm dev`. If specs fail in ways that make
> no sense, run against a clean port instead of killing your dev server:
> `NEXT_DIST_DIR=.next-e2e PLAYWRIGHT_PORT=3001 pnpm test:e2e`

## Things that will fail CI if you miss them

**The accessibility gate is blocking.** `tests/e2e/a11y.spec.ts` runs
axe-core over the five highest-traffic surfaces and fails on any
serious/critical WCAG A/AA violation. Its known-issue allowlist is
currently **empty** — please keep it that way. If a violation genuinely
has to ship temporarily, add an entry whose `reason` names the pending
fix, and delete it in the same PR as that fix.

New interactive UI should be reachable and operable by keyboard.
`tests/e2e/onboarding-keyboard.spec.ts` is the worked example. Note that
button-styled radio groups use the shared
`lib/use-roving-radiogroup.ts` helper rather than hand-rolled key
handling.

**Copy changes go through i18n.** `locales/en.json` is the source of
truth; every other locale is round-tripped through Crowdin. Add your key
to `en.json`, mirror it in the other locale files (a machine translation
is fine — translators fix it later), and run `pnpm lint:i18n`. Don't
rename or strip ICU placeholders (`{count, plural, ...}`) without
checking both bundles.

**Lint config is deliberate.** `biome.jsonc` disables a handful of a11y
rules with an inline rationale block, because the patterns they flag
(button-styled radios, click-outside-close overlays) are intentional here
and handled correctly. If you want to re-enable one, migrate the
underlying pattern in the same PR.

**Dependencies are Renovate's job.** Don't hand-bump versions or
reintroduce a `dependabot.yml` — see the Renovate section of AGENTS.md.

## Pull requests

- Branch off `main`, keep it short-lived, and open the PR against `main`.
  Every merged commit should be releasable.
- One coherent change per PR. Mixed-concern PRs are hard to review and
  harder to revert.
- Explain **why** in the description, not just what — the diff already
  says what. If you found something surprising, say so; this codebase
  has a lot of comments explaining non-obvious decisions and that's on
  purpose.
- Include the verification you actually ran. "Full suite green, 441 unit
  tests" beats "should work".

`main` is protected: PRs require review and green CI before merging.

## Reporting bugs and security issues

- **Bugs and features:** use the
  [issue templates](https://github.com/privacykey/privacytracker/issues/new/choose).
- **Security:** don't open a public issue — use
  [private vulnerability reporting](https://github.com/privacykey/privacytracker/security/advisories/new).
  See [SECURITY.md](.github/SECURITY.md).
- **Questions:** [Discussions](https://github.com/privacykey/privacytracker/discussions)
  or [SUPPORT.md](SUPPORT.md).

## Code of Conduct

Participation is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md).
