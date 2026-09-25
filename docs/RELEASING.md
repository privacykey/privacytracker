# Releasing privacytracker

Release preparation and publication are separate. Version changes go through a
reviewed pull request. Tag builds prepare a **draft** GitHub release; a maintainer
publishes it only after inspecting the candidate. Never replace assets on a
published release. Fix a bad candidate before publication; use a new version for
a bad public release.

## Upgrading from v0.1.2

v0.1.2 is the last release, and the last on the Node backend. The next is
v0.3.0, the first on the Rust backend. v0.2.0 was prepared on 2026-09-05
but never tagged or released, so everything below applies to the first
upgrade from v0.1.2.

- **Docker:** set a strong, unique `AUDITOR_ADMIN_TOKEN` in `.env` before
  upgrading. For example, generate one with `openssl rand -hex 32` and keep it
  in your password manager. Authentication is required even when the host port
  is published only on localhost: other containers can reach the service.
  See [secure deployment](SECURE_DEPLOYMENT.md) for login and proxy setup.
  A missing token must fail closed, rather than expose private data.
- **macOS:** releases after v0.1.2 require **13.5 or later** on Intel and
  Apple Silicon. That
  floor came from the bundled Node 24 runtime; a build on the Rust backend
  carries no Node, and keeps 13.5 anyway, because that is the floor the app
  has shipped and been tested against. Lowering it is a deliberate decision
  with its own testing, not a side effect of dropping Node. v0.1.2 cannot negotiate an OS minimum through its
  static updater. Upgrade once using the new release's DMG or Homebrew on a
  supported Mac. From then on the app uses `latest-v2.json` for normal in-app
  updates.
  Every release retains the original signed v0.1.2 `latest.json`; older clients
  must never be offered a later release through that file. This does not make v0.1.2 a
  supported security-maintenance branch.
- **Recovery:** quit the desktop app or stop the container, then copy the whole
  data directory, including `privacy.db`, any WAL/SHM files, and
  `backup-signing.key`. Keep the old application/image and this untouched copy.
  v0.1.2 JSON backups omitted devices, app/device links, review history, activity
  and related-app observations. Later releases fix those omissions, but cannot recreate
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

1. On a branch, run `pnpm release:prepare 0.3.0` (or the explicit next version).
   This updates `package.json`, the Rust package and lockfile, and moves the
   Unreleased notes into a dated release section, with a compare link from the
   last release tag. It names any section whose version was never tagged, as
   `0.2.0` is: fold those entries into the new notes rather than leave a dated
   section for a release nobody can download. Then write a short summary for
   people upgrading at the top of the new section, and end it with a
   `[//]: # (release-notes-end)` line after a blank line. It renders as
   nothing, on GitHub and on the docs site (an HTML comment would drop text
   from the docs site's changelog page). The draft release body is the text
   above that line, so it stays readable and under GitHub's 125,000-character limit,
   and the full list below it stays in `CHANGELOG.md`. The release check
   refuses a body over the limit before anything is built; a section without
   the line is used whole. Review the notes, especially the compatibility and
   recovery requirements above. Open a PR and merge only
   after the required checks and review pass. If the version is already prepared
   in the PR, do not run the command a second time.
2. Create a signed/annotated `v0.3.0` tag at the reviewed main commit and push it
   using a maintainer identity. The **Prepare verified release draft** workflow
   also supports manual dispatch on that existing tag. It rejects branch refs,
   tags off main, version mismatches and already-published releases.
3. The workflow invokes the desktop and Docker jobs directly, so it does not
   rely on a `GITHUB_TOKEN` push triggering another workflow. Approve signing
   only after checking the tag and commit.
4. Desktop jobs build natively on Intel and Apple Silicon. They check bundle
   version, OS minimum, architecture, native-addon loading, code signatures,
   notarization and Gatekeeper. The server must also pass an isolated
   v0.1.2 upgrade, authenticated restore and restart rehearsal: the extracted
   standalone tree on the node backend, the packaged app itself on the rust one. The assembler requires both platforms and
   verifies updater signatures with the same verifier used by Tauri. Missing,
   altered or wrongly signed archives stop manifest creation.
5. Docker jobs scan the **exact immutable image digest** for each architecture,
   including OS and application packages. HIGH/CRITICAL findings prevent named
   manifest promotion; an untagged candidate digest may already exist in GHCR.
   Provenance and SBOM generation remain enabled. Inspect both scan reports and
   the final cryptographic attestation verification against the repository,
   publishing workflow and source commit. Docker tags are produced by this workflow;
   GitHub desktop assets remain draft until the manual publication step.

### Which backend a build ships

**macOS desktop release** takes a `backend` input. `rust`, the default since
the desktop cutover, ships the Rust backend: the app serves itself, the
frontend is staged into `Contents/Resources/site` (about 9 MB against the
Node tarball's ~200 MB), no Node is fetched or bundled, and the bundle is
signed with `entitlements-rust.plist`, which grants none of the three
entitlements V8 needed. `node` bundles the Next.js standalone tree and a
verified Node binary, as every release up to v0.1.2 did. It stays buildable
as the rollback until v0.3.0 has shipped.

`Prepare verified release draft` passes `backend: rust`. To roll back,
change that line in `.github/workflows/release.yml` to `node` in a reviewed
PR and release a NEW patch version: the updater never installs an older
version, so an earlier Node build cannot be re-promoted. Either backend
opens the database the other wrote (CI's handoff test checks both ways), so
a rollback needs no data migration. To rehearse a build without releasing,
dispatch **macOS desktop release** on a reviewed tag with `dry_run=true`,
and `backend=node` for the rollback build.

**Build & Push Docker image** takes the same `backend` input, passed to the
Dockerfile as its `BACKEND` build argument, and `Prepare verified release
draft` passes `backend: rust` to it as well. `rust` builds the Rust server on
Alpine (about 56 MB, no Node); `node` builds the `next start` image every
release up to v0.1.2 shipped. The two open the same volume as the same user,
so a Docker rollback is the same one-line change in `release.yml` and a new
patch version. A self-hoster who builds from the compose file rolls back with
`PRIVACYTRACKER_BACKEND=node` in `.env`.

Either way the verifier checks the same things about the bundle (version,
OS minimum, architecture, signature, notarisation) and then what is specific
to the backend: for `rust`, that no Node ships, that the staged site is
complete, that the entitlements are the strict set, and that the packaged
app itself opens a v0.1.2 database, serves its pages and survives a restart.

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
      `latest.json`; the new release sees the new feed. Exercise an actual in-app update
      between signed candidate versions before relying on that path.
- [ ] On a test device, exercise backup verification, cancellation and recovery.
      Test uninstall only with a deliberately disposable app/device and verify
      that the confirmation and unlock gates work. Unit tests do not substitute
      for hardware behavior.
- [ ] Rehearse a crash during each bulk job and verify one safe resume, no
      duplicate snapshots and cleared locks on completion. The automated suite
      covers runner behavior; inspect it on the packaged runtime too.
- [ ] **First release on the Rust backend only.** Upgrade an installation of
      the last Node release (v0.1.2) holding a copy of a real database, through
      the DMG: v0.1.2's frozen feed never offers a later release. Confirm the data survives, that
      `standalone/` is gone from the data directory after the first launch,
      and that the accessibility quick toggles survive a quit and relaunch
      (the port is stable now, so the page's storage is too). Compare the
      bundle's size and the running app's memory with the Node build. Then
      rehearse the rollback: run a `backend=node` dry-run build over the data
      directory the Rust build wrote, and confirm it serves it.
- [ ] Upgrade an existing Docker volume and the optional bind-mount deployment.
      On the first release on the Rust backend, the volume must be one the last
      Node image (v0.1.2) wrote (build it from the `v0.1.2` tag if the registry
      has no image for it), and the rollback is rehearsed too: the same
      volume opened again by an image built with `BACKEND=node`.
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
