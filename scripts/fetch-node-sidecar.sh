#!/usr/bin/env bash
#
# Download + verify the Node binary that gets bundled as the desktop
# app's sidecar, into `src-tauri/binaries/node-<target-triple>`.
#
# Why this exists: `scripts/stage-standalone.mjs` wraps this binary in
# a fake `.node-helper.app` bundle (macOS only — LSUIElement keeps the
# sidecar out of the Dock) and tars it into `standalone.tar`. That step
# is FATAL when the binary is missing, so a fresh clone cannot run
# `pnpm tauri:dev` / `pnpm tauri:build` until this script has run once.
# The binaries are ~115MB each and gitignored (see src-tauri/.gitignore),
# which is why they are fetched on demand rather than committed.
#
# ── Which version? ───────────────────────────────────────────────────
# The rule is NOT "always the latest" and NOT "always what CI pins" —
# it is:
#
#   The bundled Node's ABI must match the Node that ran `pnpm install`.
#
# better-sqlite3 is a native module. `pnpm install` fetches/builds the
# prebuild for the ABI of whatever Node ran it, and stage-standalone
# copies that same `better_sqlite3.node` into the bundle. If the
# bundled Node's ABI differs, the sidecar dies on first require with
# `NODE_MODULE_VERSION` mismatch — after a build that looked completely
# clean. (Node 24 → ABI 137, 25 → 141, 26 → 147.)
#
# So the default here is the version of the Node running this script,
# which on a dev machine is the same Node that ran `pnpm install`.
# `.github/workflows/macos-release.yml` sets up Node 24.20.0, installs
# under it, and pins NODE_VERSION=24.20.0 — internally consistent, and
# the reason CI's pin can differ from yours without either being wrong.
#
# Override explicitly when you know what you're doing:
#   NODE_VERSION=24.20.0 bash scripts/fetch-node-sidecar.sh
#
# ── Verification ─────────────────────────────────────────────────────
# Mirrors the release workflow: GPG-verify the detached signature over
# SHASUMS256.txt using the Node release team's keys, and only then
# check the tarball's hash against that now-trusted file. A bare hash
# check is not enough — anyone who can swap the tarball can swap
# SHASUMS256.txt alongside it, but cannot forge a release-team
# signature over it. Keys are imported into a throwaway GNUPGHOME so
# your own keyring is never touched.
#
# Usage:
#   bash scripts/fetch-node-sidecar.sh          # fetch if missing
#   FORCE=1 bash scripts/fetch-node-sidecar.sh  # re-fetch even if present
#
# Prereqs: curl, shasum, tar, gpg (`brew install gnupg`).
# Safe to re-run; writes only into src-tauri/binaries/ and a temp dir.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binaries_dir="${repo_root}/src-tauri/binaries"

# NODE_RELEASE_KEYS is the SINGLE source of truth for this repo — the
# macos-release.yml workflow calls this script rather than keeping its
# own copy, so there is one list to maintain. Keep it in sync with the
# "Release keys" section of https://github.com/nodejs/node#release-keys.
# SHASUMS256 is signed by exactly one release member, so a stale list
# fails closed with a gpg verification error — it never silently passes.
NODE_RELEASE_KEYS="
5BE8A3F6C8A5C01D106C0AD820B1A390B168D356
DD792F5973C6DE52C432CBDAC77ABFA00DDBF2B7
CC68F5A3106FF448322E48ED27F5E38D5B0A215F
8FCCA13FEF1D0C2E91008E09770F7A9A5AE15600
890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4
C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C
108F52B48DB57BB0CC439B2997B01419BD92F80A
A363A499291CBBC940DD62E41F10027AF002F8B0
"

# ── Resolve version ──────────────────────────────────────────────────
if [[ -z "${NODE_VERSION:-}" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "fetch-node-sidecar: no \`node\` on PATH and NODE_VERSION unset." >&2
    echo "  Set NODE_VERSION explicitly, e.g. NODE_VERSION=24.20.0 $0" >&2
    exit 1
  fi
  NODE_VERSION="$(node -p 'process.versions.node')"
  echo "fetch-node-sidecar: defaulting to the host Node (${NODE_VERSION}) so the"
  echo "                    sidecar ABI matches the better-sqlite3 built by \`pnpm install\`."
fi
NODE_VERSION="${NODE_VERSION#v}"

# ── Resolve platform → (target triple, Node's own arch label) ────────
# TAURI_BUILD_TARGET / TAURI_ENV_TARGET_TRIPLE select the triple
# explicitly — the same two variables `scripts/stage-standalone.mjs`
# consults when it picks which binary to wrap, so setting one makes both
# halves agree. CI passes matrix.target through TAURI_BUILD_TARGET.
# Unset, we infer from the host, which is what a dev wants.
os="$(uname -s)"
machine="$(uname -m)"
requested_triple="${TAURI_BUILD_TARGET:-${TAURI_ENV_TARGET_TRIPLE:-}}"

if [[ -n "${requested_triple}" ]]; then
  case "${requested_triple}" in
    aarch64-apple-darwin) triple="${requested_triple}"; node_arch="arm64"; node_os="darwin" ;;
    x86_64-apple-darwin)  triple="${requested_triple}"; node_arch="x64";   node_os="darwin" ;;
    *)
      # Same reasoning as the host case below: only macOS bundles a Node.
      echo "fetch-node-sidecar: nothing to do for target ${requested_triple}." >&2
      echo "  The bundled-Node helper is macOS-only; stage-standalone.mjs skips it elsewhere." >&2
      exit 0
      ;;
  esac
  # Cross-compiling is legitimate (stage-standalone.mjs supports it) but
  # worth saying out loud: better-sqlite3 in node_modules was built for
  # the HOST arch, so a cross-built bundle is only correct if the install
  # was done for the target arch too.
  host_node_arch="arm64"; [[ "${machine}" == "x86_64" ]] && host_node_arch="x64"
  if [[ "${node_arch}" != "${host_node_arch}" && "${os}" == "Darwin" ]]; then
    echo "fetch-node-sidecar: WARNING cross-target — fetching ${node_arch} Node on an ${host_node_arch} host." >&2
    echo "  Only correct if \`pnpm install\` also resolved better-sqlite3 for ${node_arch}." >&2
  fi
else
  case "${os}:${machine}" in
    Darwin:arm64)  triple="aarch64-apple-darwin"; node_arch="arm64"; node_os="darwin" ;;
    Darwin:x86_64) triple="x86_64-apple-darwin";  node_arch="x64";   node_os="darwin" ;;
    *)
      # stage-standalone.mjs only builds the helper bundle on macOS
      # (`process.platform === "darwin"`), so no other platform needs a
      # bundled binary today — sidecar.rs falls through to PATH node.
      echo "fetch-node-sidecar: nothing to do on ${os}/${machine}." >&2
      echo "  The bundled-Node helper is macOS-only; stage-standalone.mjs skips it elsewhere." >&2
      exit 0
      ;;
  esac
fi

dest="${binaries_dir}/node-${triple}"

if [[ -x "${dest}" && "${FORCE:-}" != "1" ]]; then
  have="$("${dest}" -p 'process.versions.node' 2>/dev/null || echo unknown)"
  if [[ "${have}" == "${NODE_VERSION}" ]]; then
    echo "fetch-node-sidecar: ${dest#"${repo_root}/"} already at v${NODE_VERSION} — nothing to do."
    exit 0
  fi
  echo "fetch-node-sidecar: ${dest#"${repo_root}/"} is v${have}, want v${NODE_VERSION} — replacing."
fi

for tool in curl shasum tar gpg; do
  command -v "${tool}" >/dev/null 2>&1 || {
    echo "fetch-node-sidecar: missing required tool \`${tool}\`." >&2
    [[ "${tool}" == "gpg" ]] && echo "  Install with: brew install gnupg" >&2
    exit 1
  }
done

workdir="$(mktemp -d)"
GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
cleanup() {
  gpgconf --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf "${workdir}" "${GNUPGHOME}"
}
trap cleanup EXIT

tarball="node-v${NODE_VERSION}-${node_os}-${node_arch}.tar.gz"
base="https://nodejs.org/dist/v${NODE_VERSION}"

echo "fetch-node-sidecar: downloading ${tarball} (~50MB compressed)…"
cd "${workdir}"
curl -fsSLO "${base}/${tarball}"
curl -fsSLO "${base}/SHASUMS256.txt"
curl -fsSLO "${base}/SHASUMS256.txt.sig"

echo "fetch-node-sidecar: importing Node release keys into a throwaway keyring…"
for key in ${NODE_RELEASE_KEYS}; do
  for server in hkps://keys.openpgp.org hkps://keyserver.ubuntu.com hkps://pgp.mit.edu; do
    if gpg --batch --quiet --keyserver "${server}" --recv-keys "${key}" 2>/dev/null; then
      break
    fi
  done
done

echo "fetch-node-sidecar: verifying the release-team signature over SHASUMS256.txt…"
gpg --batch --verify SHASUMS256.txt.sig SHASUMS256.txt

echo "fetch-node-sidecar: verifying the tarball hash against the trusted SHASUMS256.txt…"
grep " ${tarball}\$" SHASUMS256.txt | shasum -a 256 -c -

tar xzf "${tarball}" -C "${workdir}"

mkdir -p "${binaries_dir}"
cp "${workdir}/node-v${NODE_VERSION}-${node_os}-${node_arch}/bin/node" "${dest}"
chmod +x "${dest}"
# An unsuffixed copy too, matching the release workflow, for any
# host-side build probes that look for a plain `node`.
cp "${dest}" "${binaries_dir}/node"

echo "fetch-node-sidecar: installed v$("${dest}" -p 'process.versions.node') (ABI $("${dest}" -p 'process.versions.modules')) at ${dest#"${repo_root}/"}"
