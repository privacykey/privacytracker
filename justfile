# List available commands
default:
    @just --list

# Install dependencies
[group("dev")]
setup:
    pnpm install

# Run the unit test suite
[group("dev")]
test:
    pnpm run test

# Run the Playwright end-to-end suite
[group("dev")]
test-e2e:
    pnpm run test:e2e

# Lint, typecheck, and locale-key parity — same as CI's quality job
[group("dev")]
lint:
    pnpm run lint
    pnpm run typecheck
    pnpm run lint:i18n

# Build the Next.js app
[group("dev")]
build:
    pnpm run build

# Start the dev server
[group("dev")]
run:
    pnpm run dev

# Prepare a version change for review in a PR (no tag or publication)
[group("ship")]
release-prepare version:
    pnpm release:prepare {{version}}

# Build a draft from an existing reviewed tag; see docs/RELEASING.md
[group("ship")]
release tag:
    gh workflow run release.yml --ref {{tag}}

# E2E stays separate — it builds and serves the whole app.
# Run every non-E2E suite: unit, Tauri (cargo), iOS import helper (python)
[group("dev")]
test-all: test
    pnpm run test:tauri
    pnpm run test:ios-import-helper

# Storybook dev server on :6006
[group("dev")]
storybook:
    pnpm run storybook

# The two `-node` recipes below hard-fail without this; it's a no-op once
# the binary is present, and the default recipes never need it.
# src-tauri/binaries/README.md covers why the binary isn't committed and
# why the version must match your `pnpm install` Node.
# One-time per clone: fetch + GPG-verify the bundled Node sidecar
[group("desktop")]
fetch-node-sidecar:
    bash scripts/fetch-node-sidecar.sh

# Needs the Rust toolchain. The app serves itself from the Rust core, so
# there is no sidecar and no standalone tarball, only the frontend
# `pnpm build` writes, which this runs for you.
# Run the desktop app on the Rust backend, with devtools
[group("desktop")]
tauri-dev:
    pnpm build
    pnpm run tauri:dev

# The Node sidecar build is the rollback until 1.0. Needs a one-time
# `just fetch-node-sidecar`.
# Run the desktop app on the Node sidecar, with devtools
[group("desktop")]
tauri-dev-node: fetch-node-sidecar
    pnpm run tauri:dev:node

# Stages the frontend and the third-party notices into the bundle's
# Resources (scripts/stage-site.mjs, scripts/stage-notices.mjs).
# Production desktop build (.app/.dmg) on the Rust backend
[group("desktop")]
tauri-build:
    pnpm run tauri:build

# Production desktop build (.app/.dmg) on the Node sidecar, the rollback
[group("desktop")]
tauri-build-node: fetch-node-sidecar
    pnpm run tauri:build:node

# The names the Rust recipes had while that backend was opt-in.
alias tauri-dev-rust := tauri-dev
alias tauri-build-rust := tauri-build

# Hand a database from one backend to the other, both ways (needs a
# `pnpm build` and a built pt-core).
[group("rust-core")]
handoff:
    node scripts/parity/handoff.mjs

# Rust-side unit tests only
[group("desktop")]
test-tauri:
    pnpm run test:tauri

# Rust-core (Phase 1) crate tests — the SQLite schema/migration port
[group("rust-core")]
test-core:
    pnpm run test:core

# Runs over fresh, legacy and current+state databases; the logical schema is
# the authoritative comparison. See core/README.md.
# Schema gate: prove the Rust migrator matches lib/db.ts byte-for-byte
[group("rust-core")]
parity-schema:
    pnpm run parity:schema

# Needs an already-running, already-seeded Node server — pass its base URL and
# data dir:  just parity-read http://127.0.0.1:3001 /path/to/data
# Read gate: prove the Rust read API is byte-identical to Node's
[group("rust-core")]
parity-read node data:
    # No `--` separator: pnpm forwards it verbatim and parseArgs then reads
    # `--node` as a positional argument and refuses to start.
    pnpm run parity:read --node {{node}} --node-data {{data}}

# Write gate: the read gate plus the manifest's mutations for the write
# routes the Rust core implements, replayed live against both servers last.
# Mutates both databases — re-seed the Node server before running it again.
[group("rust-core")]
parity-write node data:
    pnpm run parity:read --node {{node}} --node-data {{data}} --mutate

# Walks app/api/**/route.ts and fails if scripts/parity/manifest.mjs leaves a
# route unclassified or lists one that is gone. Needs no servers; CI's
# core-parity job and `pnpm test` run the same check.
# Coverage gate: every API route is classified in the parity manifest
[group("rust-core")]
parity-manifest:
    pnpm run parity:manifest

# Runs the REAL lib/changelog.ts diffSnapshots over a table of snapshot pairs
# and records its output as core/tests/fixtures/diff-cases.json. The parity
# differ cannot see that function at all (every seeded app diffs to nothing),
# so this fixture is the only thing that catches a wrong port. CI re-runs it
# and fails if the checked-in file has drifted. See core/README.md.
# Regenerate the diffSnapshots differential fixture from the Node source
[group("rust-core")]
parity-diff-cases:
    pnpm run parity:diff-cases

# Runs the REAL Node code behind the settings reads — the feature-flag
# resolver, reconcileLayout/matchDashboardPreset and maskWebhookUrl — and
# writes both the rule tables the Rust server include_str!s
# (core/src/server/flag_rules.json) and the differential fixture its tests
# replay (core/tests/fixtures/settings-cases.json). CI re-runs it and fails
# if either checked-in file has drifted. See core/README.md.
# Regenerate the settings-read rule tables + differential fixture from the Node source
[group("rust-core")]
parity-settings-cases:
    pnpm run parity:settings-cases

# SQLite lives in the privacytracker-data named volume; AGENTS.md has
# the bind-mount variant and the backup command.
# Run the production stack in Docker
[group("deploy")]
docker:
    docker compose up --build -d

# Tail the Docker stack's logs
[group("deploy")]
docker-logs:
    docker compose logs -f web

# Stop the Docker stack (data volume survives)
[group("deploy")]
docker-down:
    docker compose down

# Local-only baselines; docs/CSS.md is the contract. Re-baseline first
# with: just visual --update-snapshots
# Visual-regression net for CSS changes
[group("dev")]
visual *args:
    VISUAL=1 npx playwright test tests/e2e/visual.spec.ts {{args}}

# Needs a production build serving on :3001 with a DISPOSABLE data dir —
# the header of scripts/capture-screenshots.mjs has the exact commands.
# Capture the docs screenshot set
[group("ship")]
screenshots:
    pnpm run screenshots

# Advisory without a REPO_AUDIT_TOKEN — see AGENTS.md.
# Read-only drift check of the repo's GitHub settings
[group("ship")]
audit-repo:
    pnpm run audit:repo-settings
