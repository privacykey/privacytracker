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

# Needs the Rust toolchain + tauri-cli (cargo install tauri-cli).
# Run the desktop app: standalone stub, then `tauri dev` with devtools
[group("desktop")]
tauri-dev:
    pnpm run tauri:dev

# Production desktop build (.app/.dmg via tauri-bundler)
[group("desktop")]
tauri-build:
    pnpm run tauri:build

# Rust-side unit tests only
[group("desktop")]
test-tauri:
    pnpm run test:tauri

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
