# Stage 1 — Build
#
# Node version is pinned to the same exact image digest as `engines.node` in
# package.json (`>=24.0.0 <26.0.0`) allows. Two reasons not to drift:
#   1. Bumping past 25 means losing the bundled corepack (deprecated in
#      Node 25, removed in Node 26).
#   2. Node/pnpm/native-addon installs are intentionally built on native
#      runners per architecture in CI. Keeping the runtime pinned still avoids
#      surprise native ABI churn between the amd64 and arm64 image legs.
ARG NODE_IMAGE=node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
ARG PNPM_VERSION=11.0.6

FROM ${NODE_IMAGE} AS builder

ARG PNPM_VERSION

WORKDIR /app

RUN apk add --no-cache python3 make g++

# pnpm via `npm install -g`. corepack would also work on Node 24, but
# we use npm so the same line keeps working if/when Node ever decides
# corepack stays gone for good. npm itself is bundled, so this adds no
# extra layer.
#
# Pinned to an exact pnpm patch instead of a floating major so Docker builds
# don't change resolver behaviour under the same commit.
RUN npm install -g pnpm@${PNPM_VERSION} --no-audit --no-fund

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
FROM ${NODE_IMAGE} AS runner

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
COPY --from=builder --chown=audit:audit /app/lib/db-worker.cjs ./lib/db-worker.cjs

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
