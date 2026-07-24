<div align="center">

<img src="public/brand-icon.png" alt="privacytracker" width="120" />

# privacytracker

**See how iOS apps quietly change what they collect about you.**

</div>

---

privacytracker keeps an eye on the privacy labels Apple shows on each app's
App Store page — the *Data Used to Track You*, *Data Linked to You* and *Data
Not Linked to You* sections — and tells you when an app you use changes them.
It can also summarise developer privacy policies in plain language and pull
historical label snapshots back to 2021 so you can see how an app's data
practices evolved over time.

It runs entirely on your own computer. No accounts, no servers, no tracking.

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
[user guide](https://privacytracker-docs.privacykey.org/quickstart)
for setup.

## Screenshots

<!-- Drop screenshots into docs/screenshots/ and link them here.
     Suggested set:
       1. Dashboard with the privacy-label severity heatmap
       2. Per-app timeline showing a label change over time
       3. AI policy summary panel
       4. Wayback historical import view
-->

> 📸 *[The user guide](https://privacytracker-docs.privacykey.org/quickstart)
> walks through every screen.*

## Learn more

Full documentation lives at
**[privacytracker-docs.privacykey.org](https://privacytracker-docs.privacykey.org/introduction)**:

- [User guide](https://privacytracker-docs.privacykey.org/quickstart) — how to import apps, read privacy labels, set up alerts
- [AI provider setup](https://privacytracker-docs.privacykey.org/quickstart) — bring your own OpenAI / Anthropic / local model
- [Architecture](https://privacytracker-docs.privacykey.org/develop/architecture) — for developers and contributors
- [Architecture & workflows (in-repo)](docs/ARCHITECTURE.md) — end-to-end diagrams of every process, with weak points marked and an improvement backlog
- [Security](https://privacytracker-docs.privacykey.org/security) — how to report a vulnerability

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

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
