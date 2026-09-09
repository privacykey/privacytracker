# Releasing privacytracker

Release preparation and publication are separate. Version changes go through a
reviewed pull request. Tag builds prepare a **draft** GitHub release; a maintainer
publishes it only after inspecting the candidate. Never replace assets on a
published release. Fix a bad candidate before publication; use a new version for
a bad public release.

## v0.2 upgrade requirements

- **Docker:** set a strong, unique `AUDITOR_ADMIN_TOKEN` in `.env` before
  upgrading. For example, generate one with `openssl rand -hex 32` and keep it
  in your password manager. Authentication is required even when the host port
  is published only on localhost: other containers can reach the service.
  See [secure deployment](SECURE_DEPLOYMENT.md) for login and proxy setup.
  A missing token must fail closed, rather than expose private data.
- **macOS:** v0.2 requires **13.5 or later** on Intel and Apple Silicon, matching
  the bundled Node 24 runtime. v0.1.2 cannot negotiate an OS minimum through its
  static updater. Upgrade once using the matching v0.2 DMG or Homebrew on a
  supported Mac. v0.2 then uses `latest-v2.json` for normal in-app updates.
  Every release retains the original signed v0.1.2 `latest.json`; older clients
  must never be offered v0.2 through that file. This does not make v0.1.2 a
  supported security-maintenance branch.
- **Recovery:** quit the desktop app or stop the container, then copy the whole
  data directory, including `privacy.db`, any WAL/SHM files, and
  `backup-signing.key`. Keep the old application/image and this untouched copy.
  v0.1.2 JSON backups omitted devices, app/device links, review history, activity
  and related-app observations. v0.2 fixes those omissions, but cannot recreate
  data absent from an old JSON file. Use the stopped directory copy for rollback.
- A backup from another installation requires explicit trust confirmation.
  API keys and webhook URLs are omitted from new exports; dangerous developer
  options are never enabled by restoring a backup. Reconfigure credentials on
  the destination. A full private backup includes private notes; a shared audit
  bundle still excludes them.

## One-time signing environment setup

A repository administrator must configure **Settings → Environments →
macos-signing** with a required **human user or team** reviewer and exactly one
selected deployment policy: tag `v*`. An organization name is not a user reviewer.
Keep Apple and updater private keys scoped to this environment. The release
preflight checks reviewer presence and the tag restriction before entering the
environment; missing or unreadable protections fail the build. The weekly
repository-settings audit also reports drift.

The current automation account may have write permission without administration
permission. In that case an administrator must make this setting change. Do not
remove the preflight to work around it. Confirm the run pauses for review and
that an ordinary branch cannot enter the signing environment.

## Prepare a candidate

1. On a branch, run `pnpm release:prepare 0.2.0` (or the explicit next version).
   This updates `package.json`, the Rust package and lockfile, and moves curated
   Unreleased notes into a dated release section. Review the notes, especially
   the compatibility and recovery requirements above. Open a PR and merge only
   after the required checks and review pass. If the version is already prepared
   in the PR, do not run the command a second time.
2. Create a signed/annotated `v0.2.0` tag at the reviewed main commit and push it
   using a maintainer identity. The **Prepare verified release draft** workflow
   also supports manual dispatch on that existing tag. It rejects branch refs,
   tags off main, version mismatches and already-published releases.
3. The workflow invokes the desktop and Docker jobs directly, so it does not
   rely on a `GITHUB_TOKEN` push triggering another workflow. Approve signing
   only after checking the tag and commit.
4. Desktop jobs build natively on Intel and Apple Silicon. They check bundle
   version, OS minimum, architecture, native-addon loading, code signatures,
   notarization and Gatekeeper. The extracted server must also pass an isolated
   v0.1.2 upgrade, authenticated restore and restart rehearsal. The assembler requires both platforms and
   verifies updater signatures with the same verifier used by Tauri. Missing,
   altered or wrongly signed archives stop manifest creation.
5. Docker jobs scan the **exact immutable image digest** for each architecture,
   including OS and application packages. HIGH/CRITICAL findings prevent named
   manifest promotion; an untagged candidate digest may already exist in GHCR.
   Provenance and SBOM generation remain enabled. Inspect both scan reports and
   the final cryptographic attestation verification against the repository,
   publishing workflow and source commit. Docker tags are produced by this workflow;
   GitHub desktop assets remain draft until the manual publication step.

For a signing-only rehearsal, run **macOS desktop release** on an existing
reviewed tag with the same `tag` input and `dry_run=true`. It uploads workflow
artifacts only, unsets notarization credentials, skips release creation/uploads
and does not open a Homebrew PR. These unnotarized artifacts are not distributable.
Run the full candidate build to obtain notarized distribution artifacts.

## Required checks before publication

Record the candidate commit/tag, workflow run links, artifact SHA-256 values,
OS versions and results in the release review. A green PR alone is insufficient.

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm lint:i18n`,
      `pnpm test:ios-import-helper`, build and browser checks pass.
- [ ] Build `scripts/verify-updater` with `cargo build --locked --manifest-path
      scripts/verify-updater/Cargo.toml`, then run `pnpm test:release`.
      The suite includes valid signatures, altered bytes, a wrong key, missing
      platforms, bad versions and signing-only credential handling.
- [ ] Run **Nightly live integrations** manually in strict mode at the candidate
      ref; App Store fixtures must still parse. Investigate upstream changes
      rather than silently accepting a skipped or advisory run.
- [ ] Install the exact downloaded signed DMGs on Intel and Apple Silicon.
      Include a macOS 13.5 environment in compatibility testing. Verify first
      launch, readiness, login, About version, app import, quit/relaunch and
      absence of Gatekeeper errors. Record `codesign`, `spctl` and stapler output.
- [ ] Upgrade a disposable v0.1.2 installation with representative data using
      the manual DMG path. Confirm apps, private notes, history, device links and
      preferences survive. Confirm an old client still sees version 0.1.2 on
      `latest.json`; v0.2 sees the new feed. Exercise an actual in-app update
      between signed candidate versions before relying on that path.
- [ ] On a test device, exercise backup verification, cancellation and recovery.
      Test uninstall only with a deliberately disposable app/device and verify
      that the confirmation and unlock gates work. Unit tests do not substitute
      for hardware behavior.
- [ ] Rehearse a crash during each bulk job and verify one safe resume, no
      duplicate snapshots and cleared locks on completion. The automated suite
      covers runner behavior; inspect it on the packaged runtime too.
- [ ] Upgrade an existing Docker volume and the optional bind-mount deployment.
      Confirm authenticated access, denied anonymous private reads, readiness,
      persistence across restart and successful backup restore.
- [ ] Restore a same-installation backup and a trusted cross-installation backup.
      Verify missing credentials are clear. Roll back using the **old runtime
      plus the untouched old data directory**, never assume old code can safely
      consume a migrated database. The automated v0.1.2 fixture rehearsal covers
      schema migration and restore; it does not certify every user's data.

Only after all applicable checks pass, publish the existing draft without
rebuilding its assets. The publication event then opens a Homebrew cask PR with
both DMG hashes and macOS 13.5 as the minimum. Review that PR before merging it.
Never paste tokens, private signing keys or real private backups into run logs.
