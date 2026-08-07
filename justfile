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

# Lint (ultracite) and typecheck
[group("dev")]
lint:
    pnpm run lint
    pnpm run typecheck

# Build the Next.js app
[group("dev")]
build:
    pnpm run build

# Start the dev server
[group("dev")]
run:
    pnpm run dev

# Run the release workflow (bumps version, tags, publishes)
[group("ship")]
release bump="patch":
    gh workflow run release.yml -f bump={{bump}}
