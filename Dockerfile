# Stage 1 — Build
#
# Node version is pinned to the same major as `engines.node` in
# package.json (`>=24.0.0 <26.0.0`). Two reasons not to drift:
#   1. Bumping past 25 means losing the bundled corepack (deprecated in
#      Node 25, removed in Node 26).
#   2. Node 26's arm64 binaries use newer CPU instructions (ARMv8.3-A
#      BTI / PAC) that QEMU's user-mode emulation crashes on with
#      `qemu: uncaught target signal 4 (Illegal instruction)` during
#      `pnpm install` — multi-arch builds in CI use QEMU to cross-build
#      arm64 from an amd64 runner. Sticking with Node 24 keeps the
#      multi-arch image build green.
FROM node:26-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

# pnpm via `npm install -g`. corepack would also work on Node 24, but
# we use npm so the same line keeps working if/when Node ever decides
# corepack stays gone for good. npm itself is bundled, so this adds no
# extra layer.
#
# Pinned to pnpm 10 to match `pnpm/action-setup@v6` (`version: 10`) in
# the GitHub Actions workflows and the `lockfileVersion: '9.0'` in
# pnpm-lock.yaml. pnpm 11 would silently rewrite the lockfile to v10
# and the next CI run would fail with a frozen-lockfile mismatch — do
# not bump this without bumping the action-setup `version` field too.
RUN npm install -g pnpm@10 --no-audit --no-fund

# Copy lockfile + manifest + workspace config in one layer so any change
# to deps invalidates the install layer cleanly. pnpm-workspace.yaml
# carries the install-script allowlist (better-sqlite3 etc.); without
# it, native bindings won't compile inside the container.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Stage 2 — Runtime (no build tools needed). Stays on the same major
# as the builder so the better-sqlite3 binding compiled above keeps
# its NODE_MODULE_VERSION compatible at runtime.
FROM node:26-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
# Next.js telemetry is off-by-design for a local-first privacy tool.
ENV NEXT_TELEMETRY_DISABLED=1

# Create a dedicated non-root user so the process isn't running as UID 0.
# Alpine's `adduser -S` creates a system user with no login shell.
RUN addgroup -S audit && adduser -S -G audit audit

# Copy compiled app and its runtime dependencies from builder. Assign
# ownership to the non-root user so the app can read its own files but
# can't escalate via file permissions.
COPY --from=builder --chown=audit:audit /app/.next            ./.next
COPY --from=builder --chown=audit:audit /app/node_modules     ./node_modules
COPY --from=builder --chown=audit:audit /app/package.json     ./package.json
COPY --from=builder --chown=audit:audit /app/next.config.js   ./next.config.js

# Persistent data volume for SQLite. Pre-create so the non-root user owns it
# even on first start (otherwise better-sqlite3 would try to mkdir inside a
# root-owned WORKDIR).
RUN mkdir -p /app/data && chown -R audit:audit /app

VOLUME ["/app/data"]

EXPOSE 3000

USER audit

# Use the dedicated /api/ready endpoint so Docker only marks the container
# healthy once SQLite is reachable and the data directory is writable.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/ready || exit 1

CMD ["node_modules/.bin/next", "start"]
