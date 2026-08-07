<div align="center">

<img src="public/brand-icon.png" alt="privacytracker" width="120" />

# privacytracker

**See how iOS apps quietly change what they collect about you.**

[Install for macOS](#macos--homebrew-recommended) ·
[Run with Docker](#linux--windows--self-host) ·
[Documentation](https://docs.privacytracker.privacykey.org/introduction)

</div>

---

privacytracker keeps an eye on the privacy labels Apple shows on each app's
App Store page — the *Data Used to Track You*, *Data Linked to You* and *Data
Not Linked to You* sections — and tells you when an app you use changes them.
It can also summarise developer privacy policies in plain language and pull
historical label snapshots back to 2021 so you can see how an app's data
practices evolved over time.

It runs entirely on your own computer. No accounts, no servers, no tracking.

The policy summaries are the one optional exception, and they are **off by
default**. Turning them on means bringing your own model — OpenAI, Anthropic,
or any OpenAI-compatible endpoint including a local Ollama — under
**Settings → AI Policy Summaries**, or during onboarding. Nothing is sent
anywhere until you configure a provider yourself.

## What it does

**Get your apps in.** Four ways, because there is no good API for "what is
installed on my phone": screenshots of your App Library (read with on-device
OCR), a text or CSV file, an Apple Configurator export, or typing names in.
There is also a stdlib-only [Python helper](scripts/ios-app-import) that reads
an iTunes backup or a connected device and writes a list you can feed in.

**Watch what changes.** Re-syncs diff each app's labels against the last
snapshot and tell you what moved — a new tracking category, a permission that
became linked to your identity. The per-app timeline shows every change since
you started tracking it.

**Decide what you are comfortable with.** Set a privacy profile — *Strict*,
*Balanced*, *Anti-tracking only*, *Permissive*, or per-category — and the app
flags which of your apps do not match, rather than leaving you to read
fourteen categories per app yourself.

**Work out what to remove.** Review recommendations and a shortlist help you
go from "this is uncomfortable" to a decision, and you can compare apps
side by side before choosing between them.

**Set it up for who you are helping.** The interface adapts depending on
whether you are looking at your own phone, helping someone else with theirs,
or checking a child's — the last of which adds age-rating checks and a
parental-controls guide. It also has an accessibility mode where colour is
never the only signal.

Also in the box: manual entries for apps that were never on the App Store,
a customisable dashboard, statistics, backup and restore, an exportable audit
bundle, and webhook notifications.

## Get it

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
[user guide](https://docs.privacytracker.privacykey.org/quickstart)
for setup.

## Learn more

Full documentation lives at
**[docs.privacytracker.privacykey.org](https://docs.privacytracker.privacykey.org/introduction)**:

- [User guide](https://docs.privacytracker.privacykey.org/quickstart) — how to import apps, read privacy labels, set up alerts
- [Architecture](https://docs.privacytracker.privacykey.org/develop/architecture) — for developers and contributors
- [Architecture & workflows (in-repo)](docs/ARCHITECTURE.md) — end-to-end diagrams of every process, with weak points marked and an improvement backlog
- [Security](https://docs.privacytracker.privacykey.org/security) — how to report a vulnerability

## Where your data lives

Everything is stored in a single local SQLite file (`data/privacy.db` — a
Docker named volume by default, or the app-data directory in the desktop
build). The app restricts it to your user account on open (`0700` on the
directory, `0600` on the database files). Be aware that if you configure
an AI provider, **your API key is stored in plaintext inside that local
database** — anyone with access to your user account (or your backups)
can read it, so treat the machine as the trust boundary and prefer a
key with a spending cap. Moving desktop keys into the OS keychain is
planned.

## Project status

**Beta.** The core loop — track apps, detect label changes, browse history —
is stable and in daily use. Interfaces and database schema may still shift
between minor versions; migrations run automatically on start, but keep a
backup (Settings → Backup & Restore) before upgrading if your data matters
to you.

| Platform | Status |
| --- | --- |
| macOS (Apple Silicon + Intel) | Signed, notarised, self-updating |
| Docker / self-host | Supported — `docker compose up --build -d` |
| Linux / Windows desktop | No native build yet — Docker is the supported route |

Releases are published on
[GitHub Releases](https://github.com/privacykey/privacytracker/releases) and
the [Homebrew tap](https://github.com/privacykey/homebrew-tap), and documented in
[CHANGELOG.md](CHANGELOG.md). Versioning follows
[semver](https://semver.org/): while the project is pre-1.0, breaking changes
can land in a minor bump, and each release note calls them out. macOS
installs update themselves in the background.

## Contributing

Contributions are welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)** for
setup, the commands CI runs, and the conventions that are easy to miss (the
accessibility gate is blocking, and copy goes through i18n).

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Getting help / where to ask](SUPPORT.md)
- [Reporting a vulnerability](.github/SECURITY.md) — please don't open a
  public issue
- [AGENTS.md](AGENTS.md) — the canonical deep-dive on how everything fits
  together

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
