<div align="center">

<img src="public/brand-icon.png" alt="" width="120" />

# privacytracker

**See how iOS apps quietly change what they collect about you.**

[Install for macOS](#macos--homebrew) ·
[Run with Docker](#linux-windows--self-host) ·
[What it does](#what-it-does)

[![Project status](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FAdamXweb%2FAdamXweb%2Fmain%2Fbadges%2Fprivacykey%2Fprivacytracker.json)](https://github.com/AdamXweb/AdamXweb/blob/main/STATUS.md#privacykeyprivacytracker)
[![Release](https://img.shields.io/github/v/release/privacykey/privacytracker?label=release)](https://github.com/privacykey/privacytracker/releases/latest)
[![Licence](https://img.shields.io/github/license/privacykey/privacytracker?label=licence)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/privacykey/privacytracker/ci.yml?branch=main&label=ci)](https://github.com/privacykey/privacytracker/actions/workflows/ci.yml)

</div>

<!-- disclosure:start -->
> [!WARNING]
> **Pre-1.0 — no stable release yet.** Anything can change in any release, including a patch: APIs, config keys, file formats, and data already on disk. Keep your own backups.
> **Project status.** The badge above is generated from [my status list](https://github.com/AdamXweb/AdamXweb#project-status), which says what I promise for this project and every other one.
<!-- disclosure:end -->

---

privacytracker watches the privacy labels Apple shows on each app's App Store
page — *Data Used to Track You*, *Data Linked to You*, *Data Not Linked to
You* — and tells you when an app you use changes them. It can summarise
developer privacy policies in plain language, and pull historical label
snapshots back to 2021 so you can see how an app's data practices evolved.

It runs entirely on your own computer. No accounts, no servers, no tracking.

Policy summaries are the one exception, and they are **off by default**.
Turning them on means bringing your own model — OpenAI, Anthropic, or any
OpenAI-compatible endpoint including a local Ollama. Nothing is sent anywhere
until you configure a provider yourself.

## What it does

**Get your apps in.** Four ways, because there is no good API for "what is
installed on my phone": screenshots of your App Library (read with on-device
OCR), a text or CSV file, an Apple Configurator export, or typing names in.
There is also a stdlib-only [Python helper](scripts/ios-app-import) that reads
an iTunes backup or a connected device.

**Watch what changes.** Re-syncs diff each app's labels against the last
snapshot and tell you what moved — a new tracking category, a permission that
became linked to your identity. The per-app timeline shows every change since
you started tracking it.

**Decide what you're comfortable with.** Set a privacy profile — *Strict*,
*Balanced*, *Anti-tracking only*, *Permissive*, or per-category — and the app
flags which of your apps don't match, rather than leaving you to read fourteen
categories per app yourself.

**Work out what to remove.** Review recommendations and a shortlist help you
get from "this is uncomfortable" to a decision, and you can compare apps side
by side before choosing between them.

**Set it up for who you're helping.** The interface adapts depending on whether
you're looking at your own phone, helping someone else with theirs, or checking
a child's — the last of which adds age-rating checks and a parental-controls
guide. There's also an accessibility mode where colour is never the only signal.

Also in the box: manual entries for apps that were never on the App Store, a
customisable dashboard, statistics, backup and restore, an exportable audit
bundle, and webhook notifications.

## Get it

### macOS — Homebrew

```bash
brew tap privacykey/tap
brew install --cask privacytracker
```

### macOS — direct download

Grab the latest signed `.dmg` from
[Releases](https://github.com/privacykey/privacytracker/releases/latest).
Apple Silicon and Intel builds are both signed and notarised, so they open
without "unidentified developer" warnings and update themselves in the
background.

### Linux, Windows & self-host

Available as a Docker image — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for how the pieces fit together.

## Where your data lives

Everything is stored in a single local SQLite file (`data/privacy.db` — a
Docker named volume by default, or the app-data directory in the desktop
build). The app restricts it to your user account on open (`0700` on the
directory, `0600` on the database files).

Be aware that if you configure an AI provider, **your API key is stored in
plaintext inside that local database** — anyone with access to your user
account, or your backups, can read it. Treat the machine as the trust
boundary and prefer a key with a spending cap. Moving desktop keys into the
OS keychain is planned.

## Contributing

Contributions are welcome. The commands CI runs:

```bash
npm run lint        # ultracite
npm run typecheck   # tsc --noEmit
npm test            # node --test
npm run lint:i18n   # translation parity
```

Two conventions are easy to miss: the accessibility gate is blocking, and all
user-facing copy goes through i18n. [AGENTS.md](AGENTS.md) is the canonical
deep-dive on how everything fits together, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has end-to-end diagrams of every
process with weak points marked.

Found a security issue? Please don't open a public issue — see
[SECURITY.md](.github/SECURITY.md).

## Licence

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
