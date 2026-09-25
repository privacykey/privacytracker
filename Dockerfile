# Which server the image runs. `rust`, the default since the Docker
# cutover, is the Rust core (`pt-core serve`) over the prerendered build.
# `node` is `next start`, as every image before it ran, kept buildable as
# the rollback until v0.3.0 has shipped:
#
#   docker build --build-arg BACKEND=node .
#
# Both serve the same `next build`, open the same database in the same
# /app/data volume as the same non-root user, and answer the same
# healthcheck, so switching either way needs no data migration.
ARG BACKEND=rust

# Stage 1 — Build
#
# Keep the builder and runner on the same supported Node LTS release so
# native addon ABIs match. Pin the multi-architecture image digest; Renovate
# tracks both the version and digest.
ARG NODE_IMAGE=node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
# Keep this in lockstep with `packageManager` in package.json — the
# workflows' pnpm/action-setup steps read `packageManager` directly, so
# package.json and this ARG are the only two places the pnpm version
# lives. A drift here means Docker builds resolve deps with a different
# pnpm than CI does.
# Renovate bumps this line itself (customManagers regex in renovate.json),
# in the same grouped PR as the other pnpm pins — don't edit it by hand
# unless you're changing all of them together.
ARG PNPM_VERSION=11.18.0
# The Rust core's toolchain, and the runtime its binary runs on. Pinned like
# NODE_IMAGE, version and digest, both multi-architecture. The toolchain
# image carries gcc and musl-dev, which the bundled SQLite and ring compile
# with; the binary it builds is static, so the runtime needs no libraries
# of its own.
ARG RUST_IMAGE=rust:1.96.1-alpine3.24@sha256:a41f7740f8b45d45795624eec13a8b42263cc700f19f7e4e86e04d3dda08a479
ARG ALPINE_IMAGE=alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
# cargo-auditable writes the binary's dependency list into the binary, so
# the image scan and the SBOM see the Rust crates the way they saw
# node_modules. Without it, a vulnerable crate would pass the scan unseen.
ARG CARGO_AUDITABLE_VERSION=0.7.6

# The pinned Node image can predate an Alpine security release. Require the
# patched TLS libraries in both stages; fail the build if unavailable.
FROM ${NODE_IMAGE} AS base
RUN apk add --no-cache 'libcrypto3>=3.5.8-r0' 'libssl3>=3.5.8-r0'

FROM base AS builder

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

# Drop devDependencies now that the build is done. The runner stage copies
# this node_modules verbatim, so pruning here is what keeps build-only
# tooling (Storybook, Playwright, Biome, TypeScript, the Tauri CLI, …) out
# of the runtime image — measured ~850MB unpruned down to ~550MB. better-
# sqlite3's already-compiled native binding is a production dependency and is
# retained, so no recompile happens at runtime.
RUN pnpm prune --prod

# pnpm leaves TypeScript 7's optional native compiler packages in its virtual
# store after removing the dev-only `typescript` entry point. These Go binaries
# are build tools, never needed by `next start`; remove every platform variant
# so the runtime image does not carry their compiler-toolchain vulnerabilities.
RUN rm -rf node_modules/.pnpm/typescript@* node_modules/.pnpm/@typescript+typescript-*

# The part of the build the Rust core serves, staged as the desktop bundle
# stages it: the prerendered pages, the static chunks, the CSP hashes and
# public/. Nothing that runs; the Node runtime below does not use it.
RUN node scripts/stage-site.mjs --into /app/site

# Stage 2 — Runtime (no build tools needed). Stays on the same major
# as the builder so the better-sqlite3 binding compiled above keeps
# its NODE_MODULE_VERSION compatible at runtime.
FROM base AS runner-node

# Package managers are build tools; none are needed to serve the app. Remove
# their dependency trees and launchers from the final image only.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /opt/yarn* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx

WORKDIR /app

ENV NODE_ENV=production
ENV PRIVACYTRACKER_BIND_HOST=0.0.0.0
ENV PRIVACYTRACKER_NETWORK_EXPOSED=1
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
COPY --from=builder --chown=audit:audit /app/lib/request-limits.cjs ./lib/request-limits.cjs
COPY --from=builder --chown=audit:audit /app/lib/admin-auth.cjs ./lib/admin-auth.cjs
COPY --from=builder --chown=audit:audit /app/lib/request-origin.cjs ./lib/request-origin.cjs
# Static assets served straight from disk by a non-standalone `next start`:
# self-hosted Inter + OpenDyslexic fonts and brand-icon.png. These live under
# <cwd>/public at runtime and are NOT baked into .next, so without this copy
# every container 404s on /fonts/* and /brand-icon.png (breaking the
# "fonts are self-hosted" contract and the dyslexia-font a11y toggle).
COPY --from=builder --chown=audit:audit /app/public            ./public

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

CMD ["node", "--require", "./lib/request-limits.cjs", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]

# The Rust core, built once per architecture on that architecture.
FROM ${RUST_IMAGE} AS core-builder

ARG CARGO_AUDITABLE_VERSION

WORKDIR /src

RUN cargo install cargo-auditable --version ${CARGO_AUDITABLE_VERSION} --locked

# The core reads the app's name and version from the repository's
# package.json at compile time, one directory above the crate.
COPY package.json ./package.json
COPY core ./core
# The cargo caches are mounts, not layers, so the binary is copied out of
# target/ in the same step.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/core/target \
    cargo auditable build --release --locked --manifest-path core/Cargo.toml --bin pt-core \
    && cp core/target/release/pt-core /usr/local/bin/pt-core

# Stage 2 — Runtime for the Rust core: the binary, the staged build and the
# notices, and nothing else. No Node, no node_modules, no package manager.
FROM ${ALPINE_IMAGE} AS runner-rust

WORKDIR /app

ENV NODE_ENV=production
ENV PRIVACYTRACKER_BIND_HOST=0.0.0.0
ENV PRIVACYTRACKER_NETWORK_EXPOSED=1
# `pt-core serve` reads PORT as `next start` does, so `-e PORT=…` moves both.
ENV PORT=3000

# The core leaves `TZ` to the C library, which needs the zone database to
# honour a named zone. Without it `TZ=Australia/Sydney` would quietly mean
# UTC here, where Node answers it from its own built-in time zone data.
RUN apk add --no-cache tzdata

# The same user as the Node image at the same ids, pinned rather than left
# to `adduser -S`: an existing volume is owned 100:101, and a different id
# here could not open the database the Node image wrote.
RUN addgroup -S -g 101 audit && adduser -S -u 100 -G audit audit

COPY --from=core-builder /usr/local/bin/pt-core /usr/local/bin/pt-core
# Owned by root and only readable by the server: nothing it serves can be
# rewritten by the process serving it.
COPY --from=builder /app/site ./site
# What the image is built from, beside it: the app's own licence and notice,
# the V8 notice for the core's ports of V8's date parser and JSON messages,
# and every Rust crate in the binary (generated; see core/THIRD-PARTY-RUST.md).
COPY NOTICE LICENSE core/V8-LICENSE core/THIRD-PARTY-RUST.md ./third-party/

RUN mkdir -p /app/data && chown audit:audit /app/data

VOLUME ["/app/data"]

EXPOSE 3000

USER audit

# The same check as the Node image, through busybox's wget, so the compose
# files that restate it work with either.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/ready || exit 1

CMD ["pt-core", "serve", "--host", "0.0.0.0", "--site", "/app/site"]

FROM runner-${BACKEND}
