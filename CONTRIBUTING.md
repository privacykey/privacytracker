# Contributing to privacytracker

Thanks for helping improve privacytracker. Bug reports, documentation fixes,
translations, accessibility feedback, and code changes are all useful.

## Choose the right starting point

- Ask usage questions in [GitHub Discussions](https://github.com/privacykey/privacytracker/discussions).
- Report reproducible bugs with the [bug form](https://github.com/privacykey/privacytracker/issues/new?template=bug_report.yml).
- Propose larger changes with the [feature form](https://github.com/privacykey/privacytracker/issues/new?template=feature_request.yml) before investing in an implementation.
- Report vulnerabilities through [GitHub Private Vulnerability Reporting](https://github.com/privacykey/privacytracker/security/advisories/new), never a public issue.

Search existing issues and pull requests first. For a substantial change, agree
on the problem and scope before writing code.

## Local setup

You need Node.js 24–26 and pnpm 11.1.2.

```bash
pnpm install
pnpm dev
```

The app is then available at <http://localhost:3000>. Application state lives in
`data/privacy.db`; do not commit it or use a real database for tests.

Before changing code, read [AGENTS.md](AGENTS.md) for repository-specific
conventions and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the main data
flows and known weak points.

## Checks

Run the checks relevant to your change:

```bash
pnpm lint
pnpm lint:versions
pnpm typecheck
pnpm test
pnpm lint:i18n
pnpm test:e2e
```

Use `pnpm test:e2e` for user-flow or visual changes. The Playwright setup uses
its own `.playwright-data` directory and does not touch your normal database.

## Pull requests

Keep each pull request focused on one concern. Explain the user-facing reason
for the change, list the exact checks you ran, and include before/after images
for visible UI work. Update documentation when behavior changes, and update
both locale files when translated copy changes.

Never paste API keys, admin tokens, webhook URLs, databases, private app lists,
device identifiers, or unreviewed diagnostic output into an issue or pull
request.

By contributing, you agree that your contribution is licensed under the
project's [Apache-2.0 license](LICENSE).
