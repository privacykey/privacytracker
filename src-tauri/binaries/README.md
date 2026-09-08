# Bundled Node sidecar binaries

This directory holds the Node binary that the desktop app ships as its
**sidecar** — the process that actually serves the Next.js standalone
build behind the Tauri webview.

The binaries themselves are **not committed**. They are ~139 MB each,
they are per-platform, and they are byte-for-byte reproducible from
nodejs.org, so `src-tauri/.gitignore` excludes them:

```
/binaries/node
/binaries/node.exe
/binaries/node-*-apple-darwin
/binaries/node-*-pc-windows-msvc.exe
```

Only this README is tracked.

## Get one

```bash
bash scripts/fetch-node-sidecar.sh
```

That downloads the right build for your platform, verifies it (see
[Verification](#verification)), and writes
`src-tauri/binaries/node-<target-triple>` plus an unsuffixed `node`
copy. It is idempotent — re-running when the correct version is already
present is a no-op. Pass `FORCE=1` to re-fetch anyway.

`.github/workflows/macos-release.yml` runs the **same script** in its
`Download + verify bundled Node` step, passing `NODE_VERSION` from the
workflow-level `env:` block and `TAURI_BUILD_TARGET` from the build
matrix. So the release path and your local build share one code path and
one copy of the release-key fingerprints — there is nothing to keep in
sync between them.

`TAURI_BUILD_TARGET` (or `TAURI_ENV_TARGET_TRIPLE`) also lets you select
a target explicitly on a dev machine; unset, the script infers from the
host. It is the same variable `scripts/stage-standalone.mjs` reads when
deciding which binary to wrap, so setting one keeps both halves agreeing.
Requesting a target whose architecture differs from the host prints a
warning: `pnpm install` resolved better-sqlite3 for the *host* arch, so a
cross-built bundle is only correct if the install was cross-resolved too.

## Why a missing binary breaks the build

`scripts/stage-standalone.mjs` wraps this binary in a fake
`.node-helper.app` bundle on macOS — a sibling `Info.plist` with
`LSUIElement=true` is what keeps the sidecar out of the Dock — and tars
the result into `standalone.tar`. That step is **fatal** when the binary
is absent, so on a fresh clone both of these fail before Tauri gets
anywhere near compiling:

```
stage-standalone: cannot find Node binary at .../src-tauri/binaries/node-aarch64-apple-darwin
[ELIFECYCLE] Command failed with exit code 1.
Error The "beforeDevCommand" terminated with a non-zero status code.
```

`pnpm tauri:dev` and `pnpm tauri:build` both run
`scripts/stage-standalone.mjs`, so both need this. Nothing else does —
`bundle.externalBin` in `tauri.conf.json` is empty; this directory is
consumed only by the staging script.

Non-macOS platforms don't need a binary at all: `stage-standalone.mjs`
guards the whole helper-bundle block on `process.platform === "darwin"`,
and `resolve_node_binary` in `src-tauri/src/sidecar.rs` falls through to
whatever `node` is on `PATH`.

## Which version — the rule that actually matters

Not "the latest", and not "whatever CI pins". It is:

> **The bundled Node's ABI must match the Node that ran `pnpm install`.**

`better-sqlite3` is a native module. `pnpm install` resolves its
prebuild against the ABI of whichever Node ran the install, and
`stage-standalone.mjs` copies *that* `better_sqlite3.node` into the
bundle. Bundle a Node with a different ABI and you get a build that
looks completely clean, then a sidecar that dies on first require:

```
Error: The module '.../better_sqlite3.node' was compiled against a
different Node.js version using NODE_MODULE_VERSION 147. This version
of Node.js requires NODE_MODULE_VERSION 137.
```

ABI per major: Node 24 → 137, 25 → 141, 26 → 147.

`scripts/fetch-node-sidecar.sh` therefore defaults to **the version of
the Node running the script**, which on a dev machine is the same Node
that ran `pnpm install`. Override deliberately with:

```bash
NODE_VERSION=24.20.0 bash scripts/fetch-node-sidecar.sh
```

### Why CI's pin can differ from yours

`.github/workflows/macos-release.yml` pins `NODE_VERSION: '24.20.0'`
(Node 24 LTS "Krypton", active-LTS through Apr 2028) and *also* runs
`pnpm install --frozen-lockfile` under that same 24.20.0. It is
internally consistent, which is the only property that matters. Your
machine is consistent at whatever `node -v` says, as long as you let the
script default. Neither is wrong; copying CI's literal version onto a
host running a different Node major is.

If you deliberately want a local build that matches the shipped one
byte-for-byte, pin *both* halves — install and fetch under 24.20.0:

```bash
# with Node 24.20.0 active (nvm/fnm/volta/asdf — whatever you use)
pnpm install --frozen-lockfile
bash scripts/fetch-node-sidecar.sh
```

## Verification

The script mirrors the release workflow rather than doing a bare hash
check:

1. Download the tarball, `SHASUMS256.txt`, and `SHASUMS256.txt.sig`.
2. Import the Node release team's public keys into a **throwaway**
   `GNUPGHOME` (your own keyring is never touched), trying three
   keyservers per key.
3. GPG-verify the detached signature over `SHASUMS256.txt`.
4. Only then check the tarball's row from that now-trusted file.

Step 3 is the load-bearing one. An attacker who can swap the tarball can
equally swap `SHASUMS256.txt` next to it, but cannot forge a release-team
signature over it — so a hash check alone would verify nothing useful.

`gpg` prints `WARNING: This key is not certified with a trusted
signature` and that is expected: the throwaway keyring has no web of
trust. The assurance comes from the fingerprint matching the pinned
`NODE_RELEASE_KEYS` list, not from local trust.

That list lives in `scripts/fetch-node-sidecar.sh` and nowhere else —
the release workflow calls the script rather than keeping its own copy.
Keep it in sync with the "Release keys" section of
<https://github.com/nodejs/node#release-keys>. `SHASUMS256.txt` is
signed by exactly one release member, so a stale list fails closed with
a verification error — it never silently passes.

## Prerequisites

`curl`, `shasum`, `tar` (all shipped with macOS) and `gpg`:

```bash
brew install gnupg
```
