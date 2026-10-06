# Dependency security

Reviewed on 2026-10-01. Run `pnpm audit` as well as `pnpm audit --prod`:
development tooling has its own attack surface. Scan each of the three
Rust lockfiles separately with `cargo audit --file <lockfile>`.

Two upstream limitations remain after the available security patches:

- `glib 0.18.5` in `src-tauri/Cargo.lock` is affected by
  [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)
  (GHSA-wrw7-89jp-8q8g, Dependabot alert 1). It is a Linux-only dependency
  of Tauri's GTK 3 / WebKitGTK stack, and no released build contains it.
  Desktop releases are macOS only, and
  `cargo tree --manifest-path src-tauri/Cargo.toml --locked --target aarch64-apple-darwin -i glib`
  prints nothing, as it does for `x86_64-apple-darwin`. The Docker image is
  built from `core/Cargo.lock`, which has no GLib. Only CI's Linux jobs
  that compile the shell (`quality` and `rust-check`) build it, and no
  application code uses GLib or GTK directly. GTK 0.18 requires GLib 0.18,
  so the advisory's fixed GLib 0.20 cannot be substituted independently,
  and Tauri 2.12.1, wry 0.57.0 and webkit2gtk 2.0.2 still require GTK 0.18
  (checked on 2026-10-05). The Dependabot alert was dismissed on 2026-10-05
  as "vulnerable code is not actually used"; `cargo audit` still prints its
  warning for the desktop lockfile. Reopen the alert if a Linux desktop
  build is ever released, and check again when Tauri moves to GTK 4, which
  the Tauri 3 alphas offer.
- Storybook's `crypto-browserify` dependency brings in `elliptic 6.6.1`,
  flagged by GHSA-848j-6mx2-7j84. The audit advertises 6.6.2 as fixed, but
  that version is not published in npm as of this review. This is a
  development dependency; it is absent from the production dependency
  audit. Do not expose Storybook to untrusted networks.

CodeQL alerts 38–42 were reviewed as false positives: their fixed nonces
exist only in `desktop_auth.rs`'s `#[cfg(test)]` module. Production
`issue_bootstrap_nonce` fills 32 bytes using `ring::rand::SystemRandom`.
The dismissals retain that evidence; deterministic expiry and redemption
tests remain intact.
