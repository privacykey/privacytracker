# Dependency security

Reviewed on 2026-10-01. Run `pnpm audit` as well as `pnpm audit --prod`:
development tooling has its own attack surface. Scan each of the three
Rust lockfiles separately with `cargo audit --file <lockfile>`.

Two upstream limitations remain after the available security patches:

- `glib 0.18.5` in `src-tauri/Cargo.lock` is affected by
  [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
  It enters the Linux desktop through GTK 3 / WebKitGTK / Tauri. GTK 0.18
  requires GLib 0.18; the advisory's fixed GLib 0.20 cannot be substituted
  independently. No application code calls `VariantStrIter`, but this does
  not prove that every upstream use is unreachable. Keep the warning open
  until an upstream-compatible fix or a reviewed backport is available.
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
