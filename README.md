<div align="center">

<img src="public/brand-icon.png" alt="privacytracker" width="96" />

# privacytracker

**See how iOS apps quietly change what they collect about you.**

[Download](https://github.com/privacykey/privacytracker/releases/latest) ·
[Documentation](https://privacytracker-docs.privacykey.org/introduction) ·
[Ask a question](https://github.com/privacykey/privacytracker/discussions) ·
[Contribute](CONTRIBUTING.md)

[![CI](https://github.com/privacykey/privacytracker/actions/workflows/ci.yml/badge.svg)](https://github.com/privacykey/privacytracker/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/privacykey/privacytracker?display_name=tag)](https://github.com/privacykey/privacytracker/releases/latest)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

privacytracker is a local-first dashboard for the privacy labels Apple publishes
on every App Store listing.

- **Watch for changes** to the data your apps collect, link to you, or use to
  track you.
- **Understand privacy policies** with optional plain-language AI summaries.
- **Rebuild an app's history** from archived App Store pages back to 2021.
- **Keep your audit local** in a SQLite database on your own computer.

> No account, hosted backend, or product telemetry. Cloud AI is optional and
> uses your own provider credentials.

## Install

### macOS — Homebrew (recommended)

```bash
brew tap privacykey/tap
brew install --cask privacytracker
```

### macOS — direct download

Grab the latest signed `.dmg` from
**[Releases →](https://github.com/privacykey/privacytracker/releases/latest)**

Apple Silicon and Intel builds are both signed and notarised, so they open
without "unidentified developer" warnings and update themselves quietly in the
background.

### Linux / Windows / self-host

Available as a Docker image — see the
[user guide](https://privacytracker-docs.privacykey.org/quickstart)
for setup.

## Learn more

Full documentation lives at
**[privacytracker-docs.privacykey.org](https://privacytracker-docs.privacykey.org/introduction)**:

- [User guide](https://privacytracker-docs.privacykey.org/quickstart) — how to import apps, read privacy labels, set up alerts
- [AI provider setup](https://privacytracker-docs.privacykey.org/quickstart) — bring your own OpenAI / Anthropic / local model
- [Architecture](https://privacytracker-docs.privacykey.org/develop/architecture) — for developers and contributors
- [Architecture & workflows (in-repo)](docs/ARCHITECTURE.md) — end-to-end diagrams of every process, with weak points marked and an improvement backlog
- [Contributing](CONTRIBUTING.md) — local setup, checks, and pull-request expectations
- [Code of Conduct](CODE_OF_CONDUCT.md) — community standards and private reporting routes
- [Security](https://privacytracker-docs.privacykey.org/security) — how to report a vulnerability

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
