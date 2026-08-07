# Getting help

## Documentation first

Most questions are answered in the docs:

- **[User guide](https://docs.privacytracker.privacykey.org/quickstart)** —
  importing apps, reading privacy labels, setting up alerts
- **[AI provider setup](https://docs.privacytracker.privacykey.org/quickstart)** —
  bringing your own OpenAI / Anthropic / local model
- **[Full documentation](https://docs.privacytracker.privacykey.org/introduction)**

## Where to ask

| What you have | Where it goes |
| --- | --- |
| A question, an idea, "is this expected?" | [Discussions](https://github.com/privacykey/privacytracker/discussions) |
| Something is broken | [Bug report](https://github.com/privacykey/privacytracker/issues/new?template=bug_report.yml) |
| Something is missing | [Feature request](https://github.com/privacykey/privacytracker/issues/new?template=feature_request.yml) |
| An accessibility barrier | [Bug report](https://github.com/privacykey/privacytracker/issues/new?template=bug_report.yml&labels=bug,needs-triage,a11y&title=%5BA11y%5D%3A+) — auto-tagged `a11y` |
| A security vulnerability | [Private report](https://github.com/privacykey/privacytracker/security/advisories/new) — **not** a public issue |
| A privacy-policy concern | [Bug report](https://github.com/privacykey/privacytracker/issues/new?template=bug_report.yml&report-type=Privacy%20policy%20concern%20or%20correction) |

## What helps us help you

privacytracker runs entirely on your own machine, so we can't see anything
you don't tell us. The bug template asks for these because they're what
actually narrows a problem down:

- **How you're running it** — macOS app, Docker, or `pnpm dev`
- **The app version** — Settings → About, or the release you downloaded
- **The App Store URL** of the app involved, if it's a scraping or
  label-parsing problem
- **What you expected vs. what happened**

If labels suddenly stop appearing for every app, that's usually Apple
changing their page structure rather than something specific to your
install — mention it, those reports are genuinely useful.

## What we can't help with

- **Recovering a lost database.** Everything lives in one local SQLite
  file with no cloud copy. Settings → Backup & Restore exists for
  exactly this reason; please use it.
- **Apple's privacy labels themselves.** We report what the App Store
  page says. If a label looks wrong, the developer declared it that way —
  that's arguably the point of the tool.

## Response times

This is a small open-source project maintained in spare time. Issues are
read, but a reply may take a while. Security reports are prioritised.
