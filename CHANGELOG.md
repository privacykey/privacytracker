# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries for `v0.1.0` – `v0.1.2` were written retrospectively from the
[GitHub release notes](https://github.com/privacykey/privacytracker/releases);
they summarise each release rather than listing every merged pull request.
Going forward, changes are recorded here as they land.

## [Unreleased]

### Changed

- Privacy-policy changes are off by default in Notifications, and the
  "Privacy policy updates" toggle (`flag.notifications.types.policy_updates`)
  now does what its label says. With it on, a policy whose text changed
  since the last sync is flagged as a change to review (the grid's pending
  dot, the review panel, triage, the universal changelog) and raises a bell
  notification, which is also what the immediate webhook and the daily and
  weekly digests read. With it off, the change is still recorded on the
  app's History timeline with its diff, and nothing else. Until now the
  toggle filtered bell rows that were never written (no policy event ever
  raised one) while every policy event was flagged for review whatever the
  toggle said. A fresh install therefore notifies on privacy-label changes
  only; an install that had saved the toggle explicitly keeps its choice.

- `GET /api/diagnostics/runtime` now returns a backend-tagged envelope
  (`backend`, `schemaVersion: 2`, `process`, `heap` with a `kind` of `v8`,
  `sqlite`, `scheduler` with a `kind` of `event-loop`, `http`,
  `slowQueries`, `dbWorker`, `scrapeActivity`, `rateLimiter`) in place of
  the Node-shaped `memory` / `v8Heap` / `resourceUsage` / `eventLoop` /
  `apiTimings` keys. Sections a backend cannot measure are `null`, never
  zeros. The same envelope replaces `runtime_metrics` + `db_worker` in
  `GET /api/desktop/diagnostics` (as `runtime_diagnostics`) and `runtime` +
  `apiTimings` + `dbWorker` in the support bundle (`schemaVersion` 3). The
  Diagnostics page reads the new shape; the health check's persisted
  result is unchanged. This is the contract the Rust core will serve from
  its own process — with `rust-allocator` / `tokio` sections and SQLite
  page-cache and lock-wait numbers Node cannot report — so the page is
  written once. Pinned by a plain-JS validator
  (`scripts/parity/diagnostics-envelope.mjs`) that both the parity harness
  and `tests/app/runtime-diagnostics.test.ts` hold the payload to.

### Fixed

- A device re-sync now merges only the duplicate apps its preview found.
  When a re-sync finds one app stored twice, under two App Store ids with
  the same bundle ID, confirming it moves the notes, verdicts, shortlist
  entries and history from the copy on the device to the copy the new
  import found, then deletes the first. The pairs to merge came back from
  the browser and the server only checked that each named two apps, so a
  stale preview, a faulty client or a crafted request could merge two
  unrelated apps and delete one of them. The server now checks every pair
  before merging anything, and skips any whose two apps do not share a
  bundle ID, whose first app is not on the device being re-synced, or
  whose second app already is. The merged count shown after a re-sync
  counts only the merges that ran. The Rust core, not yet active in any
  build, does the same.
- The Activity log now records a privacy policy that the per-app scrape
  throttle skipped as "Policy skipped: throttled". It said "Policy source
  fetched (cached)", or "Policy summary ready" for a fetch and summary,
  although nothing was fetched or summarised. This covers a single app's
  policy refresh and every app that a Re-sync, Sync All, import or bulk
  policy run skipped. The Rust core, not yet active in any build, does the
  same.
- Turning on "Disable policy scraping" while a bulk policy run is under
  way no longer judges the apps left in it by what they stored before. An
  app whose last fetch had failed was counted as failed and logged as a
  new "Fetch failed", and an app with a summary was counted as a success,
  although neither was fetched. Both are now counted as skipped and logged
  as "Policy skipped: scraping disabled". The Rust core does the same.
- "Rescrape policy" on an app's AI Policy tab no longer reports a failed
  fetch as a success. The background-task tray said "✓ Policy re-fetched"
  whatever happened. It now says "Policy fetch failed" when the policy
  page could not be fetched, and "Policy text not usable" when it was
  fetched but was too short or not an HTML or text document.
- The AI Policy tab no longer says that Re-sync and Sync All leave the
  privacy policy alone. Both re-fetch it in the background once they
  finish, except within the policy scrape throttle's cooldown or while
  policy scraping is disabled. They don't summarise it. The note on the
  tab now says so.
- In the desktop app, "Sync now" and "Import Wayback history" on the menu
  bar icon now start a sync and a Wayback import, and the zoom level set
  from the View menu (Zoom In, Zoom Out, Actual Size) is kept when the app
  is quit and reopened. Until now the two menu items did nothing and the
  zoom went back to 100% at every launch, with nothing on screen to say
  why: the app's own requests to its built-in server carried no `Origin`
  header, so the server refused them as cross-origin, the check that stops
  a website from driving it. Developer builds also forgot whether the Web
  Inspector was open, for the same reason. "Sync now" on the menu bar icon
  also asked for a server route that does not exist. It now starts the
  same sync as "Sync now" in Settings.
- An App Store sync, Wayback import or privacy-policy sync that the app
  finishes after a restart is now shown as resumed. The run picked up
  where it had stopped, but it went on looking like the run that was
  interrupted: Background tasks never listed it as "Resumed after
  restart", the Wayback import settings never showed their "Resumed after
  restart." note, and its Activity log entry never ended with "(resumed
  after restart)" (for the Wayback import, never began "Wayback import
  (resumed)"). All of these now appear. A resumed App Store sync is logged
  as a scheduled sync even when the run it finishes was started by hand,
  as the upgrade guide describes, and the apps it syncs after the restart
  show "Scheduled sync" in their history.
- Background tasks no longer says "Resumed after restart" about a
  privacy-policy batch that was never interrupted. A "Re-scrape all
  policies" or "Summarise all policies" run still going when the page is
  reloaded, or when the app is open in a second tab, is listed there as a
  "Privacy-policy sync", and that card said it had been resumed after a
  restart although nothing had restarted. It now says "Running in the
  background". A run the app resumed after a restart still says so.
- The "Privacy-policy sync" card in Background tasks now keeps up with
  the batch it shows. When a "Re-scrape all policies" or "Summarise all
  policies" run was still going after the page was reloaded, in a second
  tab, or after Cancel (which stops the page following the run, not the
  run itself), the card showed the app and progress it first saw and then
  stood still until the run finished. It now follows the run to the end.
- "Install & restart" in the desktop app's update banner now restarts into
  the new version. The update installed, but the restart after it was
  refused ("process.restart not allowed. Plugin not found") because the
  desktop app was built without Tauri's process plugin, so the banner said
  "Install failed" and offered a manual download of the version that had
  just been installed. The plugin is now included, allowed to restart the
  app and nothing else. If a restart ever fails after an update installs,
  the banner now says the update is installed and asks you to quit and
  reopen privacytracker to finish.
- Removing apps from a device in the desktop app no longer accepts Apple's
  `MobileSync` folder as a device backup. Removal asks for a fresh,
  verified backup: a folder directly inside
  `~/Library/Application Support/MobileSync/Backup` that holds a non-empty
  `Manifest.db`. The "directly inside" check also let through the backup
  folder's parent, `MobileSync` itself, so a `Manifest.db` placed there
  could be recorded as a backup and meet that requirement without backing
  up any device. That folder is now refused, however its path is written.
  Backups the app makes with Apple Configurator are unaffected. The Rust
  core, not yet active in any build, does the same.
- "Rescrape policy" and "Rescrape + summarise" on an app's AI Policy tab
  now fetch the policy even when it was fetched less than an hour ago.
  The per-app scrape throttle in Settings, meant for the background, bulk
  and import runs, held back these buttons too: within its cooldown (60
  minutes by default) a click fetched and summarised nothing, yet the task
  tray said "Policy re-fetched" or "Summary updated" and the Activity log
  recorded a fetch or a new summary. The buttons now pass the throttle.
  Onboarding's policy step and background runs still respect it, and
  "Disable policy scraping" still stops the buttons.
- "Re-scrape all policies" and "Summarise all policies" in Settings now
  count the apps the policy scrape throttle skipped. The throttle skips a
  privacy policy fetched within its cooldown (60 minutes by default), but
  a bulk run judged each app by the log of its previous policy run
  instead of this one. An app skipped after a fetch was counted as a
  success: the run's summary, its toast and the Activity log said "Bulk
  policy scrape: 2 ok, 1 failed" when one of the two had not been
  fetched, and only a second skip in a row came out as throttled. Skipped
  apps are now always counted as throttled ("1 ok, 1 failed, 1
  throttled") and marked ⏸ in the background-task tray. A single app's
  policy refresh that the throttle skips (`POST /api/policy/regenerate`)
  now answers with that run's own log and update time, as the app's
  policy status already reported.
- A failed "Summarise" on an app's AI Policy tab no longer deletes the
  summary it was refreshing. When the AI call failed, the tab dropped the
  summary it was showing and said the AI summary could not be generated,
  and that summary was gone for good. It now stays on the tab, under "The
  latest AI refresh failed, so this summary may be out of date.", still
  credited to the AI model that made it, and the next summary that works
  shows under "What changed" how it differs from it. That comparison was
  also off when a refresh worked: for a policy summarised more than once
  before, "What changed" compared the new summary with an older one, not
  with the one it replaced. The Rust core, not yet active in any build,
  does the same.
- "Summarise" on an app's AI Policy tab no longer deletes the summary it
  was refreshing when the AI provider in Settings is missing its API key
  or model. The tab dropped the summary it was showing and said AI
  summaries were disabled, and the next summary that worked compared
  itself under "What changed" with an older one. The summary now stays on
  the tab, still credited to the AI model that made it, under "The latest
  AI refresh could not run because no AI provider is fully set up in
  Settings, so this summary may be out of date.", and the next summary
  that works is compared with it. The Rust core, not yet active in any
  build, does the same.
- The "Privacy policy updates" checkbox in Settings → Notifications now
  turns policy notifications on, and stays ticked. Before, it always showed
  unticked, ticking it did not turn them on, and the box unticked itself
  once the change was saved. The other checkboxes in that section also
  went back to their defaults after a save or a reload, and now keep what
  you chose. Saving the section also reset every notification type that
  had been turned on or off elsewhere in the app, including accessibility
  change and new data type notifications, which have no checkbox there.
  It now changes only the types you changed. The bell now shows policy
  notifications, and counts them as unread, when they are on, and hides
  the types you turn off: before, it went by the defaults whatever was
  set. `PUT /api/notification-prefs` likewise leaves alone any type a
  request does not name. The Rust core, not yet active in any build,
  reads and saves these settings the same way.
- A notification webhook set to "Each change" now posts App Store changes.
  When a sync found an app's privacy labels, accessibility labels or age
  rating changed, it wrote the bell notification but posted nothing: only
  privacy-policy text changes were sent at once, so App Store changes
  reached a webhook only when it was set to a daily or weekly summary. They
  are now posted as soon as the sync has saved them, whichever sync or
  import found them, with the first change as the headline. As with policy
  changes, quiet hours hold back the bell notification but not the post,
  and a slow or failing webhook never delays or fails the sync. The Rust
  core, not yet active in any build, posts them the same way.
- "Summarise" on an app's AI Policy tab now makes a summary after an AI
  summary failed, and after the policy was fetched before an AI provider
  was set up. In both cases the stored policy text is from the latest
  fetch that worked, but Summarise did not summarise it: no summary was
  made, and the Activity log recorded the earlier failure again ("Summary
  failed: ...") or "AI not configured", even with a provider set up. The
  only way to a summary was to fetch the policy again ("Rescrape +
  summarise" or "Retry analysis"), which is refused while "Disable policy
  scraping" is on. Summarise now summarises the stored text without
  fetching it again, so it also works with scraping disabled.
- The task tray no longer says "Summary updated" when "Summarise" or
  "Rescrape + summarise" on an app's AI Policy tab made no summary. It
  said so for every run that finished, including a failed AI summary, a
  failed fetch and a run with no AI provider set up. It now says "Summary
  failed" when the AI summary failed and "Summary not updated" for the
  rest.
- Clicking "Summarise" on an app's AI Policy tab after a failed policy
  refresh no longer adds a failure to the Activity log. A failed refresh
  keeps the policy text from the last refresh that worked, and the button
  stayed available for it, but that older text is not summarised: nothing
  happened, and the Activity log recorded a new "Fetch failed" error
  although nothing had been fetched. The button is now disabled, and asks
  for a rescrape first, whenever the stored text will not be summarised:
  after a failed refresh or one that came back too short or in a format
  that cannot be read, and for an imported policy. "Rescrape + summarise"
  does both in one pass. A Summarise request that still arrives after a
  failed refresh is logged as "Policy skipped: latest fetch failed".
- Asking for an AI summary of an app whose privacy policy has never been
  fetched no longer shows up as a failure. With no policy text to work
  from, the summarise-only request (`POST /api/policy/regenerate` with
  `phase: "summarise"`) was written to the Activity log as an error,
  "Policy summary failed", answered with an analysis marked as a failed
  AI run, and left an empty entry behind that made the app's AI Policy tab
  say the policy was fetched but the AI summary could not be generated. It
  is now logged as "Policy skipped: nothing fetched yet", answers with no
  analysis and stores nothing, so the AI Policy tab says no policy
  analysis is stored yet.
- A privacy-policy summary that came in with an imported audit bundle no
  longer reads as a failed AI refresh. The app's AI Policy tab showed it
  under "The latest AI refresh failed, so this summary may be out of
  date.", and policy text imported without a summary said the AI summary
  could not be generated, though this install had not tried to generate
  either. With "Disable policy scraping" on, the automatic policy run
  after a sync also logged each of these apps as "Policy summary failed"
  and counted it as failed. An imported summary now shows as ready and
  imported text as waiting for a summary; apps imported before this fix
  are corrected the next time the app starts. The "Summarise" button now
  waits for a rescrape of an imported policy: a bundle carries only the
  opening of the policy text, and a summary of that would read as a
  summary of the whole policy.
- With "Disable policy scraping" switched on in Settings, importing apps or
  syncing them with the App Store no longer starts a privacy-policy run in
  the background. The setting promises no bulk runs, but the automatic
  policy fetch that follows every import and sync still started one. It
  fetched nothing, yet each time it added an Activity log row for every app
  with a privacy policy link, and an app whose last fetch had failed was
  logged and counted as failing again ("Fetch failed: ...", "Bulk policy
  scrape: 0 ok, 1 failed"). While scraping is disabled that run is now
  skipped, without adding anything to the Activity log. Once scraping is
  back on, it runs again after the next import or sync.

- With "Disable policy scraping" switched on in Settings, an app whose
  privacy policy had never been fetched no longer shows up as a failure.
  Its policy run (in a bulk run already under way when scraping was
  switched off, for example) was written to the Activity log as an error,
  "Policy summary failed", counted as failed in the bulk policy total, and
  left the app's AI Policy tab saying the policy was fetched but the AI
  summary could not be generated, when nothing had been fetched at all.
  The run is now logged as "Policy skipped: scraping disabled" and counted
  as skipped, and the AI Policy tab says no policy analysis is stored yet.

- The History tab's "Show diff from previous version" shows the change it
  is asked to show. The diff trimmed a common suffix counted from the start
  of both texts instead of the end, so it reported changes as unchanged and
  put new text on the removed side: a changed last line, or a one-line
  policy with one edited word, came out as no change at all; an edit
  followed by an appended line marked the wrong lines as added and
  unchanged; and a changed line of a single word showed the new word on
  the removed line. Lines and words are now compared from the end, as
  intended.

- A privacy-policy rescrape no longer counts as a change unless the text
  changed. The first capture of a policy, an unchanged rescrape and a
  failed or unusable one (network error, wrong content type, too little
  text) all stay on the History timeline as before but are no longer
  flagged for review. An unusable scrape also no longer overwrites the
  stored hash with the rejected body's: it keeps the last policy actually
  read, as a network failure already did, so the next good scrape of
  identical text reads as unchanged rather than "changed", and the
  rejected body can no longer be seeded into the version history.

- A one-app iTunes chart is read correctly. Apple's legacy RSS charts are
  an Atom feed converted to JSON, and a chart of exactly one app carries
  its entry as a bare object rather than a one-element array. Both readers
  iterated it with `for…of`, which throws on an object: the dev seed
  answered 502 (`"entries is not iterable"`) to every `?limit=1`, and the
  Compare page's "Top in category" quick-pick silently showed "no
  candidates" for a category whose chart held a single app — its only
  candidate. `lib/itunes-rss.ts` now normalises the entry for both, with
  `tests/app/itunes-rss.test.ts` on the shapes; the routes' behaviour over
  it is pinned by the seed and discovery oracles, and the Rust core reads
  the feed the same way. Found while porting the seed route: the first
  fixture for `limit=1` had used an array, which is not what Apple sends.

- Importing an audit bundle no longer fails when its apps carry a privacy
  policy summary. The importer's upsert named a `generated_at` column that
  `privacy_policy_analyses` has never had, so SQLite refused the statement
  ("no column named generated_at") and the whole import rolled back with a
  500 — for every bundle from a recommender who had fetched at least one
  privacy policy, which is most of them. The summary, the policy excerpt
  and its fetch time now import; `updated_at` stays "when this install
  received it". Bundles without policy summaries were unaffected, which is
  how the end-to-end suite missed it; `tests/app/audit-bundle-import-policy-summary.test.ts`
  now covers the path, including "what this install exports, it can
  import".

- Keyboard access to the phone-width navigation menu. With at least one
  device imported, the closed menu's device picker could still be reached
  with Tab, so keyboard users landed on a button they couldn't see, which
  screen readers were told didn't exist (an axe "aria-hidden-focus"
  failure on every page at phone width). The closed menu now takes no
  focus at all. Escape also closes one thing at a time: with the device
  list open inside the menu, the first press closes the list and the
  next closes the menu, returning focus to the menu button. Before, one
  press closed both and left focus on a control that had disappeared.
  `tests/e2e/a11y.spec.ts` now scans the closed menu with a device
  present, and `tests/e2e/device-scope.spec.ts` covers the keyboard path.

- Accessibility on the app detail page, found by an axe scan across light,
  dark and high-contrast mode:
  - The "i" info button next to privacy categories and severity headings
    (also on the Privacy Map and Stats pages) is now a real 24x24px target
    (WCAG 2.2 target size). It was 20px with an invisible larger hit area,
    which doesn't count on the category cards, where the button sits on top
    of the card's link. Surrounding rows keep their spacing.
  - Primary buttons ("+ Add Apps", "Mark as reviewed" and every other
    filled blue button) use a deeper blue in dark mode, so their white
    labels reach AA contrast (3.6:1 before, 5.1:1 now). Their hover colour
    passes in light mode too.
  - The "N categories don't match your privacy profile" chips reach AA
    contrast in dark mode.
  - In high-contrast mode the header's Accessibility chip label was black
    on a near-black background (1.25:1); it is bright yellow again.
  - "What do you want to do with this app?" is now a level-2 heading, so
    the page's heading outline no longer skips a level.
  - The CI accessibility gate (`tests/e2e/a11y.spec.ts`) now includes the
    WCAG 2.2 AA rules, so target-size regressions fail the build.

- Accessibility on the Stats and Privacy Map pages, found by an axe scan
  across light, dark and high-contrast mode:
  - The per-app severity matrix on the Stats page is now a table for
    screen readers. Each cell announces its severity ("Used to track
    you", "Not collected", plus "exceeds your preference" where it does),
    with the app and category as its row and column headers. Before, the
    cells and preference bars carried labels that assistive technology
    ignores, so the matrix read as nothing at all.
  - The "N apps" counts in the "Most Collected Data" and "Accessibility
    Features" charts now sit after each bar instead of inside the coloured
    fill. White on the fills was as low as 1.9:1 in dark mode and 1.05:1
    on high-contrast yellow, and on short bars the count ran off the fill
    onto the track. Bars are also drawn to scale now: a one-app bar used to
    be stretched wide enough to hold its label.
  - On phones those charts put each label on its own line, left-aligned,
    with a full-height bar below. The phone layout rules had been
    overridden by the desktop ones, which left labels centred and the bars
    squashed.
  - The matrix's hover panel reaches AA contrast in dark mode (its hint,
    "Not collected" and "No preference" lines, and the red severity
    label), and its "Exceeds your preference" warning is readable in light
    mode (1.48:1 before).
  - The "Not linked" severity badge reaches AA contrast in light mode:
    the light cream is a shade deeper (4.34:1 before, 4.73:1 now).
  - The CI accessibility gate (`tests/e2e/a11y.spec.ts`) now scans both
    pages in light, dark and high-contrast mode, including the matrix's
    hover panel.

- The settings migration the app runs at startup no longer fails at every
  start on a database restored from a backup or edited by hand whose old
  notification settings (`notification_prefs`) are `null`, or whose old
  onboarding choice (`user_intent`) is the name of a built-in property
  such as `toString`. The app never saves either value itself, but either
  one stopped the migration at the same step every time: the steps after
  it never ran, among them moving the old goal settings to their new
  names, and each start added failed `migration` entries to the activity
  log and an error to the server log. Such a value is now dropped with a
  warning, as notification settings that cannot be read already were,
  and the migration finishes. The Rust core, not yet active in any build,
  does the same.

- Rust core: the data directory and database path are process-wide
  configuration (a `OnceLock`, resolved once from `PRIVACYTRACKER_DATA_DIR`
  or `<cwd>/data` exactly as `lib/db.ts` resolves them at module scope),
  no longer fields of the per-request `AppState`. CodeQL's Rust model
  treats every axum extractor — `State` included — as user-provided input,
  so a data directory that reached `fs::metadata` / `read_dir` through
  `State` was reported as `rust/path-injection` on each of the four
  deployment reads that stat the database or its directory. Kept out of the
  request's reach there is no flow to report; behaviour on the wire is
  unchanged. Developer-facing only.

- Rust-core parity harness: `read-parity.mjs` now refuses to run when copying
  the Node database would let the Rust core's unknown-device backfill fire on
  the copy. Both backends port that backfill, so whichever opens the database
  first decides what both see — a Node server booted on an empty directory and
  then seeded leaves apps with no devices, and the Rust core inventing them on
  open would make any `app_devices`-reading route (`/api/apps?meta=grid` is the
  first) differ for reasons of boot order rather than correctness. Measured at
  1 device and 22 links on a 22-app copy. Developer-facing only.

### Added

- Rust core Phase 6, batch 4a: the desktop app can run on the Rust server. Built with `--features rust-backend` the Tauri shell serves the app from its own process instead of spawning the Node sidecar: the same data directory and database, the same `next build` frontend, the environment handed over as a map rather than set on the process, no admin token, and the three seconds requests in flight had before. It also reuses the port it bound last, so the page keeps its origin and everything the app stores in the browser (the accessibility quick toggles among them) survives a relaunch, where the Node build loses them every launch. `just tauri-dev-rust` runs it, and needs neither the bundled Node nor the standalone tarball. The feature is off by default and nothing ships on it: Node, Tauri and Docker builds are unchanged unless it is passed, CI compiles the shell both ways, and the guard that keeps the core out of shipped builds was narrowed rather than deleted (the shell may name it only from the feature's own module, through an optional dependency). Gated by the shell's tests on both paths, including a boot test that starts the server over a temporary data directory and asks it for a page and an API read, and by running the app itself on the Rust backend. Seven negative controls fail exactly as predicted; two of them disagreed first and corrected the guard, which had been resting on either of two independent gates. Developer-facing only.
- Rust core Phase 6, batch 3b: the Playwright suite now runs against the Rust server too. `playwright.config.ts` takes `PLAYWRIGHT_CORE_BIN`: set, the suite's server is `pt-core serve --site .` over the same `next build` output instead of `pnpm start`, and a new CI job, `e2e-rust`, runs the whole suite that way on every push (not a required check until it has been green for a week). Its first run found a gap in the Rust port of `GET /api/apps`: it ignored `?devices=`, so after picking a device in the nav the apps grid still counted the whole library ("3 of 10 apps" instead of "3 apps tracked"), and it kept the last of a repeated query parameter where Node keeps the first. Both are fixed: the bare list, the grid's pages and their total, and the grouped view now follow the device scope with Node's SQL (the scope applied before paging, and categories with no app in scope dropped). The live gate gains 9 scoped checks (496 pass), the suite passes against the Rust server as it does against Node (73 passed, 22 skipped), and the visual net's 20 shots, captured from `next start`, match the Rust server. Negative controls fail exactly as predicted in the unit tests, the live gate and the visual net. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.
- Rust core Phase 6, batch 3a: the Rust server can serve the whole frontend. `pt-core serve --site <dir>` (or `ServeConfig { site }` for the desktop shell) serves the normal `next build` output under `<dir>` the way `next start` does: every prerendered page, the RSC payload and segment files a client navigation or prefetch fetches (after Next's `_rsc` cache-busting check), `/_next/static` and `public/` with Next's validators, ranges and caching, the three icons, the two rewrites to the view shells, the not-found page for everything else and the 405 for a page asked to do anything but GET or HEAD. Around it the server now does what `next start` does around its router: the repeated-slash redirect, the five security headers on every response, `proxy.ts`'s CSP (per page, from `csp-hashes.json`) and its matcher and page redirect to `/login`, and gzip or deflate compression. Every API response now also carries the security headers, the CSP and the router `Vary`, as Node's do, and an unknown `/api` path gets the not-found page. How Next answers each kind of request was recorded from `next start` before the port was written; a new page-parity probe in the live gate compares both servers on 404 requests over the same build (every page as a document, a HEAD, an RSC request, a prefetch and each segment, plus static and public files, icons, and 67 edge cases), all identical. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 6, batch 2b: the feature-flag migration, which Node runs once at startup, now runs when the Rust server starts too, in the same place: before the boot writes and before any timer. It turns the legacy `user_intent` into a focus and the legacy `notification_prefs` blob into per-type overrides, drops the retired callout overrides, brings the override quarantine up to date with the flag registry and moves the old goal keys to their new names, writing the same activity rows and version marker, so an install that reaches the Rust server before it ever ran the migration ends up exactly as it would on Node. Gated by a new oracle that runs the real Node migration over 45 cases, replayed by the core and regenerated in CI, with a boot test and the embed test covering the startup wiring; six negative controls fail exactly as predicted. The port first kept a Node bug, in which two stored values (a `notification_prefs` of `null`, and a `user_intent` naming an inherited property such as `toString`) failed the migration on every boot; its follow-up fixed Node and the core together (see Fixed). Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 6, batch 2a: the five device routes Phase 4 set aside, so the Rust server can back the desktop app's device features. `POST /api/device-actions/backup` records a backup cfgutil made once it verifies on disk (a non-empty, non-symlinked `Manifest.db` in a direct child of Apple's MobileSync folder); `GET /api/device-actions/uninstall` answers whether an uninstall may go ahead (whose device it is, the uninstall flag, and a verified backup no more than a day old unless the user acknowledged going without) and `POST` logs one the shell performed; and `POST /api/device-sync/preview` and `POST /api/device-sync/commit` diff a device's app list against the library and apply the selection, bundle-id merges included. None of them touches hardware: cfgutil stays in the Tauri shell. Gated by a new oracle that runs the real Node handlers over 149 cases and a recorded MobileSync-shaped tree, replayed by the core and regenerated in CI, and by a live probe that compares both servers' answers on the same host; five negative controls fail exactly as predicted. The Rust port kept two Node bugs, both since fixed in Node and the core (see Fixed): the MobileSync folder's parent passed the direct-child check, and the commit merged any two apps a client named. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 6, batch 1: an embeddable server, the first step of moving the desktop app off the Node sidecar. `server::serve_with` runs the server on a listener the host bound, with the environment the host passes: every setting the server reads now goes through `core/src/host_env.rs`, and a host that passes an environment makes it the server's whole environment, as the Tauri shell's `env_clear()` did for the Node sidecar, so the desktop app's own environment cannot change who may call the API. It hands back a handle whose shutdown stops accepting, wakes every timer so it ends, and gives requests in flight a grace before dropping them; `pt-core` now stops that way on SIGINT and SIGTERM, with three seconds. In process, a panic can no longer take the backend down with it: a handler that panics answers Next's bare 500 and the next request is served, the database connection and the shared in-memory state stay usable after a panic while locked (an open transaction is rolled back), and a timer tick that panics is logged while its loop carries on. The library logs through the `log` facade, which `pt-core` prints as before and the shell will write to the desktop log file. Gated by unit tests for each piece and a new end-to-end test that serves on a host environment while the process environment asks for a token and points at a decoy data directory; four negative controls fail exactly as predicted, every replay passes unchanged, and the live gate passes through the new `pt-core serve`. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 5, batch 4b: the policy triggers, which complete the policy pipeline. `core/src/server/policy_triggers.rs` ports the two ways Node starts policy work on its own. After a scrape asked to summarise policies (`POST /api/scrape` with `summarizePolicies: true`, and the dev seed's live walk), the app's policy now goes through the policy pipeline before the next app, as it does on Node; the seed's stand-in, which only cleared the analysis of an app with no link, is gone. And a successful scrape without that flag, an import that brought apps in, and a bulk App Store sync that synced any now ask for the deferred fetch-only policy run, which coalesces behind a two-second timer, skips while policy scraping is off, waits up to three times while another policy run holds the lock, and otherwise runs the bulk runner. Gated by a new Node-derived oracle: 19 cases of steps through the real routes with drains between them, replayed comparing each response, every raw fetch, every write, what lands after the case and nine tables; regenerated in CI. The timer itself was checked on a running pt-core. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 5, batch 4a: the bulk policy runner and its resume. `core/src/server/policy_runner.rs` ports `runBulkPolicySync` with its state blob and lock, persisted before and after each app: every app with a policy link goes through `syncPrivacyPolicyAnalysis` in the run's phase, apps that lost their link or were removed since the queue was built are skipped with the reason, and the run streams its frames, each app's phase records included. `POST /api/policy/sync-all` keeps the route's limit, refusals and start audit, answered buffered or as an NDJSON stream (spawned off the request on the server), and the server now runs the 12 s startup resume beside the Wayback and sync ones. Gated by a new Node-derived oracle: 33 cases through the real route, the runner as the post-update fetch starts it, and the resume closure captured from `instrumentation.ts`, with the network canned and replayed comparing the response or the result, the frames, every raw fetch, every write, what lands after the run and nine tables; regenerated in CI. Live, a new probe holds the route's refusals and its limit on both servers. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 5, batch 3b: the AI routes. `core/src/server/routes_ai.rs` ports `POST /api/policy/regenerate`, answered whole or, with `stream: true`, as an NDJSON stream of the run's phase records ending in the analysis (on the server the streamed run is spawned off the request and its lines go out as they come), `POST /api/ai/policy-sample`, and the two routes that reach a provider's model list, `POST /api/ai/test` and `POST /api/ai/models` (OpenAI's chat-model filter, Anthropic's paging, and Ollama's own tag list as a local endpoint's fallback). Each keeps its route's limit and refusals in its own words and order, the admin token on the two that fetch a caller-supplied URL, loopback base URLs allowed and metadata addresses never, and its audit and activity rows. The run logger gains the phase stream the regenerate route writes out. A body read that times out now reports the timeout rather than `terminated`, as the streamed read already did. Gated by a new Node-derived oracle: 123 requests to the four real route handlers with every provider reply canned, replayed comparing the response on the wire, every raw fetch, every write, what lands after the response and nine tables; regenerated in CI. Live, a new probe points both servers at a loopback fake provider and compares the connection test, the model lists, the sample summary and regenerate's summary, whole and streamed, along with what each server sent the provider. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 5, batch 3a: the summariser engine. `syncPrivacyPolicyAnalysis` now runs all three phases in `core/src/server/policy_store.rs`: `summarise` over the stored source, and `all`, which summarises only when the fetch landed a clean new source. `core/src/server/policy_summary.rs` ports `summariseStoredPolicy` (a current summary, an audit-bundle excerpt and anything but a clean source are skipped, the needs-config row is written when no provider is set, and otherwise the summary is stored with the one it replaces) and `buildPolicySummary`, which sends a policy that fits the model's limit in one call and otherwise cuts it into chunks, storing each chunk's notes as they arrive and reusing them when a retried run finds them matching. `core/src/policy/ai.rs` ports `lib/ai-config.ts`, and `core/src/policy/prompts.rs` holds the system prompt, the nonce-marked untrusted blocks, the keyword digest, the direct, chunk and merge prompts, the schemas, the skeleton a `json_object` endpoint is shown, the sample policy and the chunker. `core/src/server/policy_ai.rs` makes the calls: OpenAI with a strict `json_schema`, a custom endpoint with `json_object` and a streamed reply, Anthropic as a forced tool call, one retry on a timeout or an abort, the debounced timeout notification and the AI debug log with its fifty-row cap. The sample summary, which batch 3b's sample route serves, is ported too, as is the prompt preview, which no Node route calls. The outbound transport gains a private-host mode for a local model (metadata addresses stay blocked, on a connection pool of their own), redirect refusal, and a streamed fetch whose deadline covers every read of the body. Save Page Now and the immediate webhook now start where Node starts them rather than after the sync. Gated by a new Node-derived oracle: 72 recorded runs with every provider reply canned and each streamed body delivered in its recorded chunks, replayed comparing every raw fetch, the write stream, seven tables and the result; regenerated in CI. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 5, batch 2: the policy store and its reads. `core/src/server/policy_store.rs` ports the fetch phase of `syncPrivacyPolicyAnalysis` from `lib/privacy-policy.ts`: the run marker and the run log persisted as it grows, the scraping kill-switch and the throttle, the fetch through batch 1's source layer, a fetch error keeping the last good source and an unusable body keeping the last good hash, the first/same/changed classification, the version backfill and upsert from `lib/policy-versions.ts`, the archive lookup, the History row and the bell notification (only for a changed text with the policy-updates toggle on), the cache hit and the source-ready write, and the activity row. Save Page Now and the immediate webhook, which Node fires and forgets, are handed back for the caller to run. Routes (`core/src/server/routes_policy.rs`): `GET /api/policy/status/[appId]`, `GET /api/policy/version/[id]` and its `/diff`, `GET /api/manual-apps/[id]/policy-version/[versionId]`, and `POST /api/manual-apps/[id]/scrape` with its version folding, scrape event and audit row. The diff ports `lib/policy-diff.ts` with the suffix fix listed under Fixed, and a new crate-level `jsjson` reports `JSON.parse` failures in V8's words, positions and context, because Node stores those words in the run log; its attribution joins `core/V8-LICENSE`. Nothing calls the store outside its replay until batch 3 routes the regenerate endpoint. Gated by a new Node-derived oracle: 34 store scenarios and 35 route requests with the network canned and a clock that moves one second per awaited fetch, replayed comparing every raw fetch, the write stream, eight tables and the result or the wire response, plus V8's answer for 68 `JSON.parse` inputs; regenerated in CI. Live, the four reads join the read list over a new policy fixture, and a new probe holds the scrape's refusals and its limit on both servers. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 5, batch 1: the policy source. `core/src/policy/` ports `fetchPrivacyPolicySource` from `lib/privacy-policy.ts`, from a policy URL to a validated text: the locale rewrite of the URL and its fallback, the Google locale pin, the three-tier fetch ladder (direct with the Safari UA, the Chrome-header retry, the newest Wayback snapshot) with its block codes and retryable errors, the HTML-level redirects (meta refresh, script location) and the Google consent wall with its bypass, the policy-link second hop, HTML to text with the chrome strip, entity decoding and whitespace normalisation, and the length and topic validation, with every trace event in Node's order and words and every failure carrying Node's structured diagnostics. No routes and no database; the store, the summariser and the bulk runner are the next three batches. Two of Node's patterns pair a container with its own closing tag through a backreference the `regex` crate lacks; they are scanners here with the same left-to-right semantics, and the fixture holds a nested, an unclosed and an oddly closed container to prove it. Gated by a new Node-derived oracle: 60 recorded scenarios replayed through the same transport loop, comparing every raw fetch (one per hop), every trace event and the source or the error with its diagnostics; regenerated in CI. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 4, batch 6: the outbound leftovers — four handlers the route count had not flagged and one behaviour no route count could. `core/src/server/webhook_writes.rs` ports `lib/notification-webhooks.ts`: notification webhooks are now DELIVERED by the core (it had read the settings and sent nothing) — the immediate post from `createNotification`, then fired only for `POST /api/dev/seed-notification` because a scrape inserted its change notification itself on either backend (label changes now post it too; see Fixed); the daily and weekly summary from the 30-minute tick, self-limited through its cursor; and `POST /api/notifications/webhook-test` for the wizard's Test button. Every post goes through the same transport as every other fetch (a private address is refused), does not follow redirects, and is capped at 64 KiB back. `update_check.rs` ports `lib/update-check.ts` and `lib/semver-compare.ts` — `GET /api/update-status`, the forced check with its five-minute throttle, the cached check with its day-long TTL and doubling failure backoff, the runtime detection, and the 25 s then 6-hour tick. `favicon.rs` ports `GET /api/favicon`: `favicon.ico` first, then the site root's `<link rel>` resolved against the page's final URL, hits cached a day and misses an hour per process. `GET /api/preview` joins the compare route it shares a limiter with. The transport gains a request method and body (the webhook is the core's first outbound POST) and reports each reply's final URL. Gated by a new Node-derived oracle: 132 cases replayed comparing the wire response with its headers (the favicon's bytes as base64), the raw fetches with a POST's method and body, the write stream and three tables, regenerated in CI, with `package.json`'s version masked so a release bump does not fail the step. Live, `/api/update-status` joins the volatile reads and a new probe holds the eleven refusals the other three routes answer before any fetch, on both servers alike. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 4, batch 5d: the dev seed, which completes batch 5. `core/src/server/seed_writes.rs` ports `POST /api/dev/seed-sample-data` in both modes. Canned (`?source=canned`) writes the ten-app demo set in one transaction — each app under its slug-derived id, its accessibility features resolved against the catalogue, its hand-written policy summary stored as a real `ready` analysis with the source text's hash and word count (and, where the fixture has an earlier summary, the two policy versions that make the change banner render), the labels, and a back-dated timeline diffed step by step and saved as `triggered_by = 'sample'`. Live asks the iTunes top-free chart for a region (`?country=`, else a stored `app_country` that was actually set, else `au`) and up to twenty-five apps, skips what is already tracked, runs each of the rest through the scrape an import uses, adds two back-dated snapshots, waits 250 ms between apps and stops at Apple's rate limit with what it has. The guard requires an admin token to be configured, loopback or not. The demo set itself is data: `core/src/server/sample_apps.json`, generated from `lib/sample-apps.ts` by the oracle and regenerated in CI, so the two backends cannot drift apart on what a demo install contains. Not included, by design: Node's live walk goes on to fetch and summarise each new app's privacy policy, which is the Phase 5 policy pipeline; the core runs the one plain write of that step (clearing the analysis of an app with no policy link) and nothing further, so until Phase 5 a live seed from the core leaves the AI Policy tab empty for apps that have a link. The canned seed is unaffected. Gated by a new Node-derived oracle: 55 recorded cases with the network canned per case, replayed comparing the wire response, the raw fetches, the write stream and twelve tables; regenerated in CI. The live `read-parity.mjs --mutate` pass now ends with a seed probe: both servers are reset, each seeds itself, and the two libraries are compared in all seven seeded tables with the random ids and each server's clock taken out — the first time the gate has watched the core's own seed, or its reset, run. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 4, batch 5c: the audit bundle and the two support bundles. `core/src/server/audit_bundle.rs` ports `lib/audit-bundle.ts` and `lib/audit-bundle-import.ts` — the export (apps with their labels, accessibility features and policy summaries, annotations with private notes excluded in the SQL itself, verdicts, the recommender's profile and the preset it matches, a file name slugged from the recommender's name in local time) and the import: `validateBundle` with its errors in Node's order, the duplicate lookup, and one transaction that upserts each app unless this install's copy is at least as recently synced, replaces its labels, keeps an earlier policy summary where the bundle has none, adds the annotations, upserts the verdicts it recognises, stashes the recommender's profile as a suggestion and writes the import-history row, with every URL a bundle carries through Node's sanitisers and every value bound as better-sqlite3 binds it (numbers as doubles; a boolean or an object refused in Node's words and the import rolled back). Routes (`core/src/server/bundle_writes.rs`): `POST /api/export/audit-bundle`, `POST /api/import/audit-bundle` — as JSON or as the `multipart/form-data` upload the real client sends, parsed by a small hand-written parser (`multipart.rs`) that follows the steps of the one Node bundles, with no new dependency — `GET /api/diagnostics/bundle` and `GET /api/deployment/support-bundle`, the latter two with their redaction intact: a failed fetch is six named fields, never its URL or body, and only the eight newest errors. A bundle exported by either backend previews and imports identically on the other. Gated by a new Node-derived oracle: 94 recorded cases replayed comparing the wire response with its download headers, the write stream and eleven tables, with the two support bundles — machine state — compared as a projection of their keys, jobs, rate limits, flag overrides and redacted errors; regenerated in CI. The live `read-parity.mjs --mutate` pass now reads both support bundles and runs a new audit-bundle probe before the backup one: the export refused identically, then each server's own export previewed (as JSON and as a form), imported, refused as a duplicate in the same words and imported again on BOTH servers, and seven uploads that are not bundles refused identically. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 4, batch 5b: the backup family. `core/src/server/backup.rs` ports `lib/backup.ts` — the export (every table read in one transaction, the AI key and the webhook destination blanked at the source), the per-install HMAC-SHA256 signature over the canonical envelope (keys in UTF-16 sort order, scalars as `JSON.stringify` spells them, the key file read the way `Buffer.from(s, "base64")` reads it and minted 0600 only when a signature is made or checked), the preview with its unknown-table warnings, and the destructive restore: verified before anything is touched, foreign keys off around one transaction that wipes children-first and inserts parents-first, only columns that still exist, every row sanitised whatever the trust (denied `flag.devopts.`/`AUDITOR_` settings dropped and counted, stored URLs through `sanitizePolicyUrl`), numbers bound as doubles as better-sqlite3 binds them, `foreign_key_check` vetoing the commit. `backup_snapshots.rs` gains the settings save, the 0600 temp-then-rename snapshot write with its collision suffix, the retention prune, the activity row and the due check; the server runs the 35 s snapshot tick and the 30-minute cadence like Node does. Routes (`core/src/server/backup_writes.rs`): `PUT` and `POST /api/backup/snapshots`, `GET /api/backup/snapshots/[filename]` (the requested name only ever compared with the directory listing, never joined onto a path), `GET /api/backup/export`, `POST /api/backup/preview` and `POST /api/backup/restore` (its "a sync is running" answer given before the body is read). A backup signed by either backend verifies on the other, which is what lets an install change backend and keep its backups. `ring` becomes a direct dependency for the HMAC and the CSPRNG and adds no crate — it is already the crypto provider under reqwest's rustls. Gated by a new Node-derived oracle: 101 recorded cases — the routes and the startup hook's real 35 s closure, each against a wiped database and a data directory with a fixed signing key and seeded snapshot files (no SAVEPOINT, because `PRAGMA foreign_keys` is a no-op inside one) — replayed comparing the wire response with its download headers, the write stream, all twenty-eight tables, the snapshot directory by name, size and SHA-256, the key file, and that enforcement is back on; regenerated in CI. The live `read-parity.mjs --mutate` pass now covers the snapshot settings write and the manual snapshot, and ends with a new backup probe: Node mints the signing key before the data directory is copied so both servers share it, then each server's export is previewed on both, a snapshot is created and downloaded on each, a backup carrying the fixtures' orphan row is aborted identically at the foreign-key check, and each server's export is restored into BOTH and must come back `trusted` from the backend that did not sign it, after which the two must export the same rows. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 4, batch 5a: the health check and its non-destructive self-heal (`core/src/server/health_check.rs`) — the `health_check_running` lock with its five-minute stale takeover, the three bulk-job locks cleared only when provably dead (no state, no pending work, or silent past the stale margin; never a paused or cancel-requested queue), the import-queue lock by its age, the PASSIVE WAL checkpoint and the stuck policy-run reset both skipped while a bulk job is active, the opt-in size-gated integrity scan, the counts, orphans, warnings and status, the persisted result and its activity row; the server runs the 60 s tick and the daily cadence like Node does. Routes (`core/src/server/maintenance_writes.rs`): `POST /api/diagnostics/health`, `POST /api/diagnostics/database`, `DELETE /api/diagnostics/errors`, `DELETE` and `POST /api/diagnostics/runtime` (the profiling toggle now live), `DELETE /api/ai/debug-log`, `POST /api/auth/admin-token/login` (same-origin, the global brute-force backstop, the per-address limit, the eight-hour HttpOnly cookie marked Secure over HTTPS) and `logout`, `POST /api/csp-report` (both report shapes into the ring), `POST /api/dev/reset-changelog`, `seed-notification` and `wipe-apps`, `POST /api/reset` and `POST /api/admin/start-over`. Gated by a new Node-derived oracle: 106 recorded cases — the routes and the startup hook's real 60 s closure captured from `register()`, the in-process rings, the login counter and the event-loop monitor reset per case — replayed comparing the wire response with its cookie, the write stream, nineteen tables and the CSP ring, with the figures that belong to the process and the file blanked on both sides; regenerated in CI. The live `read-parity.mjs --mutate` pass now covers the seed, the CSP report, the four diagnostics writes, the AI-log clear, the login, the logout and the changelog reset (the wipe, the start-over and the reset are teardown entries, gated by the oracle alone), and waits for the core's 60 s health tick as well as its import-queue drain before seeding the simulated unfinished jobs, then primes a manual health run on each side and compares the stored results with each process's own figures blanked. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 4, batch 4b: the bulk Wayback import (`core/src/server/wayback_runner.rs`) — `runBulkWaybackImport` with its `wayback_bulk_state` blob and `wayback_import_running` mutex, the per-app archive walk that emits a frame per target, the one-strike backoff on a throttling archive and the pause on the second, cooperative pause and cancel at app boundaries with the in-flight request dropped on cancel, the clean completion and the outer catch that leaves state and mutex for the next boot; and the boot-time resume that leaves a paused queue alone, clears a cancelled or finished one, heals a stale lock and continues a crashed run. Routes: `POST /api/wayback/import-all` buffered and as an NDJSON stream (`?stream=1`, with `?force=1` discarding a paused queue), `PATCH` with `pause`, `cancel` and `resume` (the resumed run spawned off the request), and `DELETE`. The server runs the 8 s resume check like Node does. Gated by a new Node-derived oracle: 45 recorded cases with the network canned per case and mid-run controls issued from the stub at a given fetch, including a pause that lands during the backoff sleep and a pause requested mid-app that Node's own state write overwrites (pinned as Node behaves), replayed comparing the wire response and frames, the raw fetches, the write stream and six tables; regenerated in CI. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 4, batch 4a: the bulk App Store sync and the scheduler around it (`core/src/server/sync_runner.rs`) — `runBulkSync` with its durable `sync_bulk_state` blob and `sync_running` mutex, the per-app resync loop that stops on Apple's first 429 and counts the pending peers, `runScheduledSync`, and the startup hook's own paths: the boot writes and stale-lock clears, the scheduler's 30-minute check with its failure backoff, the import-queue drain tick and the boot-time resume that heals a stale lock or continues a crashed run with its notification and activity row. The server now runs those tickers like Node does. Routes (`core/src/server/runner_writes.rs`): `POST /api/sync/trigger`, `POST /api/dev/sync-stop`, `DELETE /api/rate-limit/status` and `DELETE /api/apps` with its import-row tombstones. Gated by a new Node-derived oracle: 52 recorded cases — the routes, and the startup hook's real closures captured from `register()` and invoked with the clock frozen — replayed comparing the wire response, the raw fetches, the write stream and twelve tables, regenerated in CI; and by the live `read-parity.mjs --mutate` pass, whose route list now covers the stop and the cooldown clear (the app delete is a teardown entry, gated by the oracle alone). Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 4, batch 3: the twelve import-pipeline write routes (`core/src/server/imports_writes.rs`) — `POST`/`DELETE /api/imports`, `POST /api/imports/items` (the planned-then-chunked upsert), `/api/imports/items/update`, `/api/imports/queue` (the forced drain with its pause fence and stale-lock override), `/api/imports/complete` (counters, device links, the activity row, the completion and manual-apps notifications), `/api/imports/items/retry` (the inline iTunes search for pending rows, the scrape for queued ones), `/api/imports/items/change-match` (rewire, garbage-collect the previous app, stale its notifications), `POST /api/search` (bundle ids, rows or names through the `lib/app-import.ts` sanitisers), `POST /api/scrape` and `POST`/`DELETE /api/apps/[id]/import-history`. The network routes hand the Phase 3 scrape, search and Wayback entry points a fetcher; every handler keeps Node's validation order, Node's SQL byte for byte, the activity, audit and notification rows, and Node's response literals. Gated by a new Node-derived oracle: 167 recorded requests with the network canned per case, replayed through the same reader, guard and handler the axum wrappers use, comparing the wire response, the raw fetches, the write stream with transaction markers and fourteen tables, regenerated in CI; and by the live `read-parity.mjs --mutate` pass, whose route list now covers the five local import routes. The routes that fetch take the connection lock per section rather than across the network: the Phase 3 scrape, search and Wayback entry points go through a `DbAccess` accessor, so a scrape, a search or an archive walk no longer blocks every other request while it waits on Apple or archive.org, and the handler futures run on the runtime like every other route. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 4, batch 2: the twenty-three library write routes (`core/src/server/library_writes.rs`) — annotations (create, edit, soft-delete, restore), verdicts (set, clear, bulk), the shortlist (add, remove by id, pair or all), review actions and their undo, notification marks, user-task actions and visits, queue-session activity, devices (create, rename, ownership and acknowledgement, merge, delete with the orphan sweep), the device scope (save, reset) and manual apps (create, update with field-change events, delete, bulk, restore). Each keeps Node's validation order, Node's SQL byte for byte, the activity and audit rows the lib modules write, and Node's response literals, including the `TypeError` text a null body surfaces where a route's `catch` turns it into a 400. Gated by a new Node-derived oracle: 354 recorded requests with foreign keys on, replayed through the same reader, guard and handler the axum wrappers use, comparing the wire response, the write stream with transaction markers and fifteen tables, regenerated in CI; and by the live `read-parity.mjs --mutate` pass, whose route list now covers these writes. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 4, batch 1: the twenty settings-style write routes (`core/src/server/writes.rs`) — `POST /api/settings` and `/api/settings/desktop`, `PUT /api/preferences`, `/api/notification-prefs`, `/api/privacy-profile` and `/api/accessibility-profile`, `POST /api/focus`, `/api/locale`, `/api/date-format`, `/api/coachmark-state`, `/api/dev-menu-state`, `/api/welcomed-at` and `/api/migration-flow/consume`, the feature-flag override writes and clears, and the dashboard layout save, reset and preset — with the shared write plumbing under them: the bounded JSON body reader with its 413 and 408, the mutation guard with the inbound rate limit and admin-token check and the audit rows each refusal leaves, and the activity-log writer with its retention cap. Every handler keeps Node's validation order (including the writes that land before a refusal), Node's SQL byte for byte, and Node's response literals; the locale cookie carries Next's Expires. Gated by a new Node-derived oracle: 255 recorded requests replayed through the same reader, guard and handler the axum wrappers use, comparing the wire response, the write stream with transaction markers and four tables, regenerated in CI. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 3, batch 4: the Wayback historical import (`core/src/scrape/history.rs`) and the archive.org client it drives (`core/src/scrape/wayback.rs`) — the quarterly target walk back to the February 2021 floor with the install-date anchor, the CDX index listing with its availability-API probe fallback, date-window and capture-URL dedupe, replay fetch and the archived-page privacy parse with its no-labels/parse-failure split, the back-dated snapshot row and the successor re-diff in one transaction with Node's SQL byte for byte, the Save Page Now request via Location or Content-Location and the attempt note it records, and archive.org throttling surfaced as the import's error with Retry-After in seconds or as an HTTP date. The outbound request gains `follow_redirects` and `read_body` for Save Page Now's manual-redirect probe. Gated by a new Node-derived oracle: 26 scenarios with recorded archive.org replies comparing every raw fetch, every write and transaction marker, the snapshot rows and the result, regenerated in CI. This completes Phase 3; Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 3, batch 3b: `searchAppsByName` and `lookupAppsByBundleId` (`core/src/scrape/search.rs`) — query normalisation, the iTunes search with its empty-result retry and developer-match reordering, the bundle lookup in chunks of a hundred with the 5xx split retry, case-insensitive matching and dedupe, the shared search cooldown a 429 records, and candidate mapping with JavaScript's absent-versus-null fields. The outbound request gains a `max_url_length` (the lookup allows 16 KiB) and the string helpers an `encodeURIComponent` port. Gated by a new Node-derived oracle: 31 scenarios with recorded iTunes replies comparing every raw fetch, every write, the settings rows and the batch object, regenerated in CI. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 3, batch 3: the fetch layer of `fetchAndParseApp` (`core/src/scrape/fetch.rs`) and `scrapeInitialUrls`, which completes the function in Rust — URL refusal, the scrape cooldown and pacer (`ratelimit.rs`), the page fetch through the outbound transport, Apple's 429/403 signal with Retry-After in seconds or as an HTTP date and the cooldown it records, non-OK statuses, transport failures, redirects, and the iTunes lookup with its storefront normalisation (`region.rs`). The transport now runs its redirect, size-cap and decoding loop over an injectable raw hop and carries response headers. Gated by a new Node-derived oracle: 36 scenarios with recorded raw replies, comparing every raw fetch made, every write, every touched table and the result, regenerated in CI. Search and bundle-id lookup follow; Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 3, batch 2: the persist path of `fetchAndParseApp` (`core/src/scrape/persist.rs`) — the pre-commit reads, label/accessibility/age-rating change detection, the single transactional commit with Node's SQL byte for byte, the parser-fallthrough, version-update and profile-mismatch notifications with their dedupe windows and retention prunes, quiet-hours `not_before`, and the error activity row with its diagnostics. Gated by a new Node-derived oracle: the real handler run end to end over 26 scenarios with a frozen clock and counted ids, recording every write in order plus the rows it leaves, regenerated in CI. No fetch or routes yet; Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 3, batch 1: the App Store page parser (`core/src/scrape/`) — page metadata, the `serialized-server-data` extraction and name rules, the privacy-type fallback chain with its swallowed-versus-escaping error boundary, both 2021 shoebox shapes, the accessibility shelf, the related-app shelves and the two three-state flags. Gated by a new Node-derived oracle: the real `fetchAndParseApp` run over 27 synthetic pages with the result projected from the rows it writes, regenerated in CI. No fetch, persistence or routes yet; Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust-core parity harness: the manifest coverage walk — every `app/api/**/route.ts` classified in `scripts/parity/manifest.mjs`, nothing phantom — now runs on its own as `pnpm parity:manifest`, in the `core-parity` CI job and under `pnpm test` (`tests/app/parity-manifest-coverage.test.ts`). Until now only `parity-diff.mjs` ran it, and the Rust read gate invokes that with `--skip-coverage`, which is how `/api/device-scope` shipped unclassified. Developer-facing only.

- Rust core Phase 2 is complete: twelve more GET routes bring the read API to all 65 routes in the Phase 2 inventory plus the newer device-scope read (66 total), covering operational status and exports, comparison previews and related apps. A bounded public HTTP client validates DNS and redirects, caps decompressed bodies and enforces deadlines. Node-derived cases and live probes preserve responses and read limits without starting jobs or persisting preview data. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 2: seven user-content GET routes (54 read routes total), covering activity, notifications and preferences, tasks, annotations, shortlists and JSON/Markdown exports. Fixed-clock Node comparisons and live response, cleanup and rate-limit probes preserve existing behavior. Rust remains inactive in shipped builds. Developer-facing only.

- Rust core Phase 2: five device GET routes (47 read routes total), preserving ownership, import history, app links and exact Node response behavior. Includes 58 Node-derived status/body cases and live parity probes. Rust remains inactive in shipped builds. Developer-facing only.

- Rust core Phase 2: nine fleet statistics and analysis GET routes (42 read routes total), with device-scope parity, fixed-clock Node oracle cases and raw-response/rate-limit probes. Rust remains inactive in shipped builds. Developer-facing only.

- Rust-core migration: the three process-introspection reads join the Rust
  read API (33 of 64 read routes) — `GET /api/diagnostics/runtime`,
  `/api/desktop/diagnostics` and `/api/diagnostics/errors` — emitting the
  backend-tagged envelope with `backend: "rust"`: a counting global
  allocator for `heap`, tokio's runtime metrics plus a 20 ms scheduler-lag
  sampler for `scheduler`, `sqlite3_memory_used` / `sqlite3_db_status` and
  the connection-mutex wait for the `sqlite` sections Node cannot fill, a
  request-timing layer with Node's sampling rule for `http`, and SQLite's
  own profile hook for `slowQueries`. The parity harness validates each
  side against the envelope contract instead of byte-comparing a V8 heap
  against a Rust allocator, and holds the Rust body to live numbers.
  Developer-facing only.
- **Importing from a second device now asks whose it is — and, for
  someone else's, asks you to confirm you have their permission.** From
  your second device onward, any import that creates a new device
  record (any method: cable, CSV, screenshots or typed in) has a "Whose
  device is this?" step: yours, someone you're helping, or a child you
  look after — pre-selected from your current setup, so your own iPad
  is one click. Your first device isn't asked, and nothing is recorded
  about its owner until you say so in Settings → Devices. Choosing
  anyone but yourself reveals a statement that you have their
  permission to view the apps on their device and to remove apps from
  it; the import won't continue until it's ticked. The confirmation is
  timestamped, recorded in the audit log, and required before the app
  will remove anything from that device. It can also be given later in
  Settings → Devices, and is cleared automatically if the device is
  reassigned to you. Your own devices — phone, iPad, work and personal
  — are never asked for it; they're told apart by name.

- **Exports now say when they're broader than the page.** Every export
  stays whole-install by design — a file whose contents depend on a
  device filter the reader can't see is worse than one that's simply
  complete — but while a device scope is active the Stats page, Settings
  → Export Data, the shortlist download and the audit bundle each carry
  a line saying so. Previously the Stats page could read "3 apps
  tracked" directly above a download containing ten, with nothing
  reconciling the two. The note disappears entirely when no scope is
  set.

- **Device ownership** — each device can record whose it is (a name, and
  whether you're working on your own apps, helping someone else, or
  looking after a child's device), set in Settings → Devices. The nav
  picker groups devices by owner, and when you scope to someone else's
  device while your focus still says "just me", it offers to switch —
  which is the gap that previously let someone drift into the
  delete-apps flow with the button silently disabled and the reason
  buried in Settings. The offer is always a suggestion with an explicit
  "Stay as I am"; nothing changes automatically, and switching preserves
  every other focus setting. Ownership is never guessed from a device's
  name. Removing apps still requires a focus of just you — that rule is
  unchanged — but the refusal now names the device you're viewing
  instead of citing the rule alone.

- **Device scope picker in the nav** — one control naming which device's
  apps you are looking at, with an icon and the device's name, and a
  multi-select popover to narrow to any subset ("show all", or just two
  of three). It applies everywhere: the apps grid, the dashboard's
  counts, Stats, the Privacy Map, the shortlist, and the review queue
  that feeds "delete apps off a phone" all follow it. Previously the only
  device control was a single-select dropdown inside the apps-grid
  toolbar, so every other surface silently spoke for the whole fleet —
  which meant someone helping a relative could be several screens into a
  removal workflow with nothing on screen saying whose phone it applied
  to. The choice persists across reloads and is gated by
  `flag.nav.device_scope`; it renders from the first device onward and
  disappears only on installs with none. Apps with no device link
  (hand-added entries and CSV
  imports) get their own "Not tied to a device" bucket rather than
  vanishing silently.

- Rust-core migration: the five deployment-facing reads join the Rust read
  API (30 of 64 read routes) — `GET /api/ready`, `/api/deployment/diagnostics`,
  `/api/diagnostics/database`, `/api/diagnostics/disk` and
  `/api/diagnostics/health`. Reproduces the `x-forwarded-*` header synthesis
  `next start` performs before route handlers run (without it the readiness
  checks differ on every direct request), embeds `package.json` for
  `app.name`/`version`, and moves `pt-core serve` to `PRIVACYTRACKER_DATA_DIR`
  / `<cwd>/data` exactly as `lib/db.ts` resolves the data directory. The
  parity harness primes a health-check result before copying the database
  and holds the connection pragmas, backup fixture and env-derived fields
  to equality where the differ blanks numbers. The three process-
  introspection diagnostics (`runtime`, `errors`, `desktop`) are left for a
  design decision. Developer-facing only.

- Rust-core migration: the four settings-backed reads join the Rust read API
  (25 of 64 read routes) — `GET /api/settings`, `/api/settings/desktop`,
  `/api/dashboard/layout` and `/api/feature-flags`. The last ports the focus
  resolver over rule tables generated from the Node source rather than
  transcribed (`core/scripts/extract-settings-cases.mjs`, with a CI drift
  check like the `diffSnapshots` fixture), and the same script records the
  real `maskWebhookUrl`, `reconcileLayout` and resolver outputs for the Rust
  tests to replay. The profile matcher's strip-underscore collation is
  replaced by an ICU-root model verified against Node on the flag keys, flag
  surfaces and category keys. The parity fixture now stores a masked secret,
  out-of-range desktop rows, a non-preset layout and flag overrides so the
  four routes are compared on real state, and a probe exercises the
  write-on-read runtime marker the differ never triggers. Developer-facing
  only.

- Rust-core migration: `/api/apps/[id]/detail` joins the Rust read API
  (21 of 64 read routes) — the fourteen-key aggregate the app-detail page
  renders, assembled from reads already ported plus three new ones
  (`getUnacknowledgedChanges`, `getRecentPolicyChange`,
  `getAppImportProvenance`). Every read but the app row degrades to its own
  fallback rather than failing the request, as in Node. Three fields are
  null on the canned seed and were only ever compared as null; the fixture
  now populates them and the probe refuses a run where they are not.
  Developer-facing only.

- Rust-core migration: `GET /api/apps` joins the Rust read API (20 of 64
  read routes) — all five of its query-string branches at once, since axum
  routes by path. Ports `getAllApps`/`getAppsPage`, `getAppWithPrivacy` with
  the full policy-analysis hydration, `getGroupedPrivacyView`, and the
  `meta=grid` side-band (`buildAppGridMeta` and its four map helpers,
  including the profile-matching engine). Five of the route's eight responses
  had no parity-manifest entry; they do now. The fixture gained a stored
  privacy profile and a user verdict so the two `meta=grid` maps the canned
  seed leaves empty are actually compared. Developer-facing only.

- Rust-core migration: `/api/apps/[id]/changelog` joins the Rust read API
  (19 of 64 read routes), bringing the timeline kernel `getChangelog` /
  `getChangelogPage` with it — including the read-time archive bridge, which
  is a second caller of the already-ported `diffSnapshots`. The manifest hits
  this route once with no query string, on an app where neither read-time
  mutation fires and no review row exists, so the parity fixture gained a
  timeline app (a wayback row identical to its live neighbour, plus review
  rows) and the probe covers `archive_bridge`, `matches_live_sync`, the
  review row shape, `hasMore` and both 400 branches. Developer-facing only.

- Rust-core migration: `/api/apps/[id]/history-stats` joins the Rust read API
  (18 of 64 read routes), porting the quarterly aggregates
  `computeCategoryTrend` and `computeQuarterlyChanges`. The canned seed
  exercises only their `added` arm — across all ten seeded apps nothing is
  ever removed, no entry is category-tagged, and `changes_detected` is only
  ever 0 or 1 — so the parity fixture gained an app covering the removal arm,
  the category filter and the strict `changes_detected !== 1`. Developer-facing
  only.

- Rust-core migration: `/api/apps/[id]/since-install` joins the Rust read API
  (17 of 64 read routes), bringing `diffSnapshots` with it — the first real
  business logic in the core rather than a read shim. The parity differ is
  structurally blind to it (every seeded app's baseline and latest snapshot
  have identical label membership, so all ten answer `"changes": []`), so the
  diff is pinned by a differential fixture generated by running the actual
  Node function, and the route by nine scenario apps whose raw response bytes
  are compared across both backends. Fixing this also fixed a harness bug that
  affected any future dynamic route: `read-parity.mjs` did not escape `[` and
  `]` when building its `--only` regex, so `[id]` was read as a character
  class and the route was never compared. Developer-facing only.
- Rust-core migration: the **inbound rate limiter** (`checkRateLimit` /
  `rateLimitKeyForRequest` from `lib/security.ts`) is ported to Rust, which
  unblocks `/api/manual-apps` and `/api/import/audit-bundle/recent` — both
  rate-gate their GET before doing any work — and takes the Rust read API to
  16 of the 64 read routes. Not to be confused with `lib/rate-limit.ts`,
  Apple's outbound scrape cooldowns, which is untouched. The parity differ
  structurally cannot see a limiter (it sends one request per route against a
  120/min limit), so `read-parity.mjs` now bursts a gated route on both
  backends and requires them to deny from the same request number.
  Developer-facing only.

- Rust-core migration **Phase 2, batch 3**: `/api/sync/status`,
  `/api/verdicts` and `/api/imports/queue` join the Rust read API, taking it
  to 14 of the 64 read routes. All byte-identical to Node, verified against a
  server seeded with real verdict and queued-import rows rather than empty
  tables. The parity differ gained `--ids-from`, for comparing a backend that
  shares the other side's database rather than being independently seeded;
  it is off by default, so the full Node-vs-Node run still proves the two
  sides agree on their own. Developer-facing only.

- Rust-core migration **Phase 2, batch 2**: `/api/focus` and `/api/imports`
  join the Rust read API, taking it to 11 routes. They add the two response
  shapes batch 1 lacked — a fully derived multi-key object, and a bare array
  with a 404 branch — and the `/api/imports?id=<missing>` error shape is now
  gated by the parity manifest, which nothing checked before. Both are
  byte-identical to Node under the dual-live differ. Developer-facing only;
  the shipped app still runs entirely on Node, and the inertness guard added
  in Phase 1 still passes.

- Rust-core migration **Phase 2, batch 1**: the `core/` crate now serves an
  HTTP read API (`pt-core serve`), starting with nine routes — the reads the
  client shell makes on first paint plus the container/auth probes. It ports
  the `proxy.ts` request gate (host allowlist, the fail-closed auth rule and
  its five exact-match public-read carve-outs, and the CSRF check), so the
  Rust server refuses what the Node server refuses. A new gate,
  `scripts/parity/read-parity.mjs` (`just parity-read`), boots it against a
  copy of a running Node server's database and byte-compares every implemented
  route; `parity-diff.mjs` gained an opt-in `--only` filter so a partially
  implemented backend can be compared without the unimplemented routes
  drowning the signal. Nine of nine routes are byte-identical, and the auth
  gate is probed separately because the differ authenticates every request and
  so cannot see a missing one. Developer-facing only; the shipped app still
  runs entirely on Node.

- Rust-core migration **Phase 1**: a standalone `core/` crate that
  reproduces the `lib/db.ts` SQLite schema + migration contract exactly.
  `pt-core migrate <path>` opens a `privacy.db` and brings its schema up to
  date — the pragma set, the 0700/0600 permission tightening, the full
  CREATE/index block, every guarded `ALTER TABLE ADD COLUMN`, and the data
  backfills db.ts runs on open (unknown-device placeholder, the
  `pending_search` heal, the stuck-`running` reset, the
  `privacy_policy_versions` seed). The CREATE block is lifted verbatim from
  db.ts by a generator so it cannot drift. A new gate,
  `scripts/parity/schema-parity.mjs` (`just parity-schema`), proves the Rust
  migrator leaves any starting database in the same schema state db.ts would
  — one Node dumper reads both sides, the logical schema is compared
  authoritatively, and data backfills are checked by aggregate counts.
  Fresh, legacy-upgrade and current+state fixtures all pass byte-identical,
  and the gate is self-tested to fail when a single migration is dropped.
  This is developer-facing only; nothing in the shipped app changes yet.

- The AI disclosure page (`/dashboard/about/ai-disclosure`) now tells the
  whole story of how the app was built, in three parts. **Before this
  repository** credits the April 2026 groundwork — the scraper, the first
  dashboard and onboarding, privacy profiles, the Wayback import, feature
  flags, localisation, the desktop build — to the era it came from, and is
  honest that the project was restarted here in May so none of that history
  carried over, that some of it was never version-controlled, and that
  neither Antigravity nor Codex records a commit co-author. **Models used**
  is the breakdown: eight models, each a collapsible row naming the areas it
  worked on, ordered by first appearance. Claude Sonnet 4.6, Opus 4.8,
  Opus 5, Fable 5 and Fable 5.1 join the entries that were already there,
  and the OpenAI entry is now *Codex* — the tool rather than a model
  version, because the version changed across the project and was never
  recorded. Its list is substantial: the September security round
  (network-deployment sign-in, outbound destination validation, bounded
  request bodies, runtime scanning, desktop backup verification), backup and
  restore data preservation, the v0.2 release gates, CSV export safety, and
  the TypeScript 7 translation-scanner work. **What the model list leaves
  out** says the part no git history records: hundreds of hours of
  real-device testing, user testing and product decisions, all of it human.
  The attribution note states plainly that the trailers are incomplete —
  they miss the pre-repository era, they miss Codex entirely, and a portion
  of this repository's own commits carry none either. The rows are native
  `<details>` elements, so they expand without JavaScript and the page keeps
  prerendering statically.

- **Per-app historical import.** The App Detail → Change History tab now
  has a "Check the archive" card that reconstructs just that app's history,
  the single-app counterpart to Settings → Historical Import. It posts the
  new `force` option on `POST /api/apps/[id]/import-history`, which
  re-probes every quarter instead of skipping the ones a nearby row already
  covers — so a second run picks up captures the archive has gained since,
  or ones an older parser could not read. Forcing never duplicates a
  snapshot. When archive.org is rate-limiting, the route answers 503 with
  `code: "archive_unavailable"` (not a 500) and the card says to wait and
  retry rather than showing a raw error. Gated by
  `flag.detail.timeline.wayback_import`.
- **History tab pages backwards.** The detail payload now carries the newest
  50 changelog rows plus `changelogHasMore`; a "Show older entries" control
  fetches the rest from the new `GET /api/apps/[id]/changelog?before=…`
  route. Every sync writes a row even when nothing changed, so on a daily
  schedule the reconstructed Wayback history used to fall off the bottom of
  the timeline after about seven weeks with no way to reach it.
- **First-run checklist task "Reconstruct your apps' label history"** for
  the self + monitor focus, linking to Settings → Admin → Historical Import.
  The import still only runs on an explicit click, as the privacy policy
  promises; the task completes once any archive row exists.
- The Wayback importer bridges the last archive → first-live-scrape hop at
  read time: the first scrape's card shows what changed since the newest
  archive capture ("Compared with the archive capture from …"), without
  rewriting the stored row or raising anything in the review queue.
- `just fetch-node-sidecar` (`scripts/fetch-node-sidecar.sh`) — downloads
  and GPG-verifies the Node binary the desktop app bundles as its sidecar,
  into `src-tauri/binaries/`. The binary is ~139MB and gitignored, so a
  fresh clone previously had no way to build the desktop app: both
  `just tauri-dev` and `just tauri-build` died several minutes in with
  `stage-standalone: cannot find Node binary at …`, after a Next build and
  a full cargo build that had both looked healthy. Both recipes now depend
  on the fetch, which is a no-op once the binary is present. The new
  `src-tauri/binaries/README.md` documents the verification chain and, more
  importantly, why the version must match the Node that ran `pnpm install`
  — better-sqlite3's prebuild is resolved against that ABI, so a mismatched
  bundle builds cleanly and then kills the sidecar with
  `NODE_MODULE_VERSION`.

### Changed

- **The device menu's "switch mode" prompt now explains what switching
  does.** It used to say "You're looking at Robin's apps. Switch to
  helping someone else?" — which assumes you already know what that mode
  is. It now states the mismatch ("Robin's device — but you're set up
  for working on your own apps") and then what the other mode actually
  turns on: for helping someone, the shareable bundle, printable
  recommendations and per-app notes, plus that it's required before
  apps can be removed from their device; for a child's device, age
  ratings and the safety summary. The button names the mode too.

- **Fixed: the apps grid scrolled the whole page sideways on a phone.**
  Its toolbar row was set never to shrink, which stopped the mobile
  wrap rule from ever applying — six buttons stayed on one line and
  pushed the page out to nearly twice the screen width. The row now
  wraps onto three lines at 375px and the page stays put.

- The local visual-regression net now covers the device-scope chrome:
  the picker open, a scoped grid, the focus-switch prompt, the scoped
  Stats page with its export note, and the device owner editor. Its
  fixture builds a fixed two-device fleet instead of deleting devices
  down to none — with no devices the picker renders nothing, so the new
  chrome had no cover at all — including two mobile shots for the
  drawer's own copy of the picker and its viewport-pinned popover, which
  share no code path with the desktop ones. Developers who keep local
  baselines will need to regenerate them
  (`VISUAL=1 npx playwright test tests/e2e/visual.spec.ts -u`).

- **App removal now checks whose device it is, not just what mode
  you're in.** Previously the gate asked only whether your focus was set
  to "just me" — so it would happily remove apps from a relative's phone
  the moment it was plugged in, while refusing to touch your own phone
  whenever you were in helping mode. It now compares the device's
  recorded owner against how you're set up: your device in your own
  mode, theirs in helping mode, a child's in guardian mode. A mismatch
  is refused, and the refusal names the device instead of citing a rule.

  This makes removal possible on a device belonging to someone you're
  helping, which was not possible before. It requires you to have
  recorded that the device is theirs and to have switched into the
  matching mode, and everything else still applies: the phone connected,
  unlocked and trusting this Mac, the feature switched on, a fresh
  verified backup, and Touch ID for every single app. Devices with no
  recorded owner behave exactly as they did before.

- **Fixed: the mobile nav drawer reported a critical accessibility
  violation once a device existed.** The drawer is a `role="menu"`,
  which may only contain menu items, and the new device-scope control
  was a plain button inside it — axe flagged `aria-required-children`.
  The control is now a menu item that opens its own submenu, which is
  what it already behaved like.

- **Fixed: the apps grid's device filter changed the counts but not the
  cards.** The risk tabs and the "N of M" figure were computed from a
  filtered list while the card list was built from a separate,
  re-implemented filter chain that never applied the device filter at
  all — so picking a device updated every number on the page and none of
  the apps. The card list is now derived from the same filtered list the
  counts use, so the two cannot disagree. Custom apps, which have no App
  Store listing and never carry a device link, are now treated as
  unattached and hidden when the scope excludes that bucket.

- The Rust-core parity harness now classifies **all 120** API routes, up
  from 17. `scripts/parity/manifest.mjs` splits them into reads (57),
  reads with a volatility transform (8), mutations (56), destructive
  teardown (4) and quarantine (35, each with a written reason), and
  `parity-diff.mjs` enforces a **coverage gate**: it walks `app/api` at
  startup and fails if any `route.ts` is unlisted. The manifest had gone
  stale while the surface grew from 110 to 120 routes with nothing
  noticing; that can no longer happen silently. The differ also gained
  write support — mutations replay against both servers with identical
  bodies and then re-read the affected collection, so a write that
  returns a plausible 200 but persists differently is caught. Writes are
  opt-in (`--mutate` / `--teardown`) because the manifest contains
  `/api/reset`; a bare invocation stays read-only. Node-vs-Node
  self-test: 130 checks, 0 differences, and `--no-normalize` still fails,
  which is what proves the differ can detect one.

- **Wayback import probes the CDX index once per app** instead of up to
  seven availability calls per target, and picks each quarter's closest
  capture locally; the availability walk remains as a fallback. Save Page
  Now now runs only when the archive has no capture within 45 days of
  today (it used to fire on the first empty quarter — usually Q1 2021,
  which archiving today's page cannot fill — for nearly every app on every
  run), and "Remove all imported history" also removes the notes it leaves.
- A throttled archive (HTTP 429 / 5xx) is now an error the bulk runner
  backs off from — it waits out `Retry-After`, retries the app once, then
  pauses the queue with a "paused by rate limiting" explanation and a
  Resume button — rather than being recorded as "no capture" and triggering
  Save Page Now.
- The monthly reconstruction cadence (`intervalMonths: 1`) now lands every
  month: the dedupe window follows the cadence (15 days monthly, 45 days
  quarterly) instead of a fixed 45 days that skipped every other month.
- `macos-release.yml` now calls `scripts/fetch-node-sidecar.sh` instead of
  carrying its own ~40 lines of inline download-and-verify shell. The
  Node release-key fingerprints had been duplicated between the workflow
  and (until now) nothing else; they have exactly one home now and cannot
  drift between CI and a developer's machine. Behaviour is unchanged —
  same GPG-then-hash verification, same output paths — with the build
  matrix's target passed through `TAURI_BUILD_TARGET`, the variable
  `stage-standalone.mjs` already reads when choosing which binary to wrap.

### Security

- Upgraded Next.js 16.2.12 → 16.3.4, clearing three advisories that were
  failing the dependency audit on every pull request:
  **two critical unauthenticated remote-code-execution issues** in Next.js
  (GHSA-p293-qw3h-jr36, affecting Windows-hosted servers, and
  GHSA-2xp9-vwfh-vxw4 in the Image Optimization API when AVIF files are
  used), and a high-severity libheif issue in the transitive `sharp`
  dependency (GHSA-rgj7-g3m4-5g8c). 16.3.3 patches the two Next.js issues
  but still resolves `sharp ^0.35.3`; 16.3.4 is the first release that
  requires the patched `sharp ^0.35.4`, so it clears all three in one bump.
  This deployment already set `images.unoptimized: true`, which disables the
  vulnerable image-optimisation endpoint, but the versions are patched
  regardless.

### Fixed

- Feature flags now actually take effect in the browser. Every client
  component that gated UI on a flag read it through a resolver context
  that nothing primes on the client — so all ~65 of those reads silently
  returned the flag's hard default, ignoring both your focus (audience /
  goals) and any override you set in Dev Options. Choosing "Keep it
  minimal" left label hints, tooltips, the Live Text walkthrough, the
  Task Center widget, Developer Options and the Wayback import section on
  screen; the loved-one audience never got its social-share or audit-PDF
  affordances; and toggling a flag in Dev Options changed nothing outside
  the panel. All of them now read resolved values from
  `GET /api/feature-flags` through one shared, cached fetch per page
  load. The broken `useFlag` / `useFocus` hooks are gone rather than
  patched — a hook that cannot be primed has no correct use — and a
  static guard (`tests/app/client-flag-reads.test.ts`) fails the build if
  they return, if a client module imports the resolver, or if a
  tri-state flag is read through a boolean hook.
- A URL with a trailing slash (`/dashboard/`) answered with a redirect that
  carried none of the app's security headers, while the canonical URL
  (`/dashboard`) carried all six. Next emits that redirect inside its router,
  before `proxy.ts` runs, and its redirect branch discards every header
  accumulated so far — including the static set from `next.config.js`. The
  redirect is now issued by `proxy.ts` itself and goes out with the full
  header set. Low severity in practice: a redirect has no body to inject
  into, and the browser followed it to a URL that was properly protected.
  This is defence-in-depth and consistency.
- The route-parity differ's opaque-id normaliser was over-eager: its pattern
  also matched ordinary snake_case enum *values* such as `not_collected`,
  rewriting them to `~id`. That silently blinded the gate — a backend
  returning the wrong privacy tier compared equal. It now requires a digit or
  capital in the suffix, which every generated id has and no English enum word
  does. Verified against the full 121-route Node-vs-Node run, and the run also
  picked up `/api/apps/[id]/changelog`, a route added after the manifest
  landed, via the coverage gate.


- Desktop app: the hash-based Content Security Policy introduced in 0.2.0
  blocked Tauri's IPC channel, so every call into the desktop app's native
  side — the notification permission check that runs on each page load, the
  updater, and the app's own commands — was rejected and silently retried
  over a slower fallback, filling the log with `connect-src` violations. The
  policy now allows Tauri's IPC origins when running inside the desktop app;
  the browser and Docker deployments keep the unchanged, narrower policy.
- **Wayback imports never actually reached 2021.** Captures from Feb–Oct
  2021 keep the app record in `shoebox-ember-data-store` (keyed by app id,
  `data.attributes.privacy`), which the shoebox extractor skipped by id and
  never probed, so every 2021 target failed as `skipped_parse_failure`
  while the Settings copy promised history "back to Q1 2021". Both shoebox
  shapes are parsed now; in a live run Instagram's history extends from
  March 2021 instead of March 2022. Captures from the first weeks of Feb
  2021 that carry no privacy section at all are reported as skipped
  (`skipped_no_labels`) rather than failed.
- The oldest imported Wayback row was diffed against *today's* labels, so
  the 2021 baseline card claimed "now collects" for labels the app had
  since dropped (and vice versa), the universal changelog carried the
  inverted entries, and the history chart's first bucket counted them. The
  oldest row is now a baseline with no changes, and a wayback row that
  lands *before* an existing one re-diffs the row that follows it.
- `history-stats` counted accessibility and privacy-policy entries as
  privacy-label changes.
- Settings copy for the Historical Import still said "since the App Store
  web launch on 5 November 2025" and that the closest capture is used;
  the floor is Q1 2021 and captures beyond 45 days are skipped. The Task
  Center deep link for a running Wayback job pointed at the device-import
  section instead of `#wayback-import`.
- A fresh install no longer probes its own install date (which equals
  "today" and is already covered by the first live scrape).

## [0.2.0] — 2026-09-05

### Added

- Canned sample data now populates every app-detail surface: each demo app
  gets its hand-written AI policy summary stored as a real, ready analysis
  (lens grid, highlights, and source preview render without any AI provider),
  declared accessibility features on the Accessibility tab, and — for
  Instagram — a policy-change history that lights up the recent-change banner
  and the rating-shift strip.
- The app-detail axe gate now also scans the Accessibility, AI Policy, and
  Change History tabs (activated and populated), and the app-detail E2E spec
  covers the change-review panel, the privacy-label accordion toggle, and all
  three tabs.
- Blocking accessibility gate in CI: axe-core scans of the welcome screen,
  onboarding import flow, dashboard, app detail, and mobile navigation, plus
  keyboard-only coverage of the onboarding path.
- Community health documentation — contributing guide, code of conduct,
  support guide, pull-request template, and code owners.
- `pnpm screenshots` — captures a consistent set of UI screenshots from
  the built-in demo fixture, for docs and release notes.
- A `justfile` collecting the common workflows — `just --list` shows the
  set, covering the dev loop, the desktop (Tauri) build, Docker, and the
  verification suites.

- A Content Security Policy mode switch for operators: `PRIVACYTRACKER_CSP`
  is `enforce` (default), `report-only` (send the policy as report-only to
  see what it *would* block), or `off` (debugging only). Violations the
  browser reports are listed on the Diagnostics page; nothing leaves the
  machine. The policy itself is now hash-based rather than nonce-based,
  which is what lets every page be served as a fixed, prebuilt file.

### Changed

- **v0.2 upgrade requirements:** Docker deployments require
  `AUDITOR_ADMIN_TOKEN`, including containers published only on localhost.
  macOS desktop builds require macOS 13.5 or later. v0.1.2 users make a one-time
  manual DMG/Homebrew upgrade; the legacy update feed remains pinned to v0.1.2
  to protect older Macs. See [release and recovery guidance](docs/RELEASING.md).
- Release versions are prepared through reviewed PRs. Tag builds stay in a
  draft, validate signing approvals, build each Mac architecture natively,
  verify both updater signatures, and scan exact Docker image digests before
  promoting image tags. Signing-only rehearsals cannot upload release assets.
- Full backups now include devices, app/device links, review history, activity
  and related-app observations. Restore clears those tables consistently,
  preventing stale links to apps absent from a backup. Keep a stopped data-folder
  copy before upgrading; older JSON backups never contained these records.

- Upgraded to TypeScript 7.0.2 and enabled Next.js's compiler CLI integration
  for web, Docker, desktop and Storybook builds, retaining build-time type
  checks with the native compiler. Docker explicitly removes native compiler
  packages left behind by dependency pruning from the shipped image.
- Translation regression checks parse JSX independently of the TypeScript
  compiler API, preserving the existing untranslated-text baseline while
  allowing the checks to run with TypeScript 7.

- **Settings is now four pages instead of one.** Your preferences, sync,
  policies and admin each get their own address
  (`/dashboard/settings/you`, `/sync`, `/policies`, `/admin`), so a page
  loads only what it needs and you can link someone straight to the part
  you mean. Existing links and bookmarks — including the ones in
  notifications — still land in the right place.

- **First-run experience.** Per-feature toggles moved behind an "Advanced"
  disclosure, illustrated goal cards shrunk on phones, and the primary action
  pinned to a sticky footer so it stays reachable. AI summaries now default to
  **Disabled** instead of preselecting a provider, and a stored "disabled"
  choice is honoured on reload. "Save & generate" stays disabled until the
  provider's fields validate. New users now get exactly one post-onboarding
  guide — the task checklist — instead of a checklist plus a coachmark tour
  pointing at it.
- Import candidate selection is now a native radio group: keyboard-operable
  with arrow keys, and announced correctly by screen readers.

- The interface language is now applied in the browser from your saved
  choice rather than on the server, so pages load as prebuilt files. The
  first paint waits for the language bundle (a brief blank rather than an
  English flash), and the no-JavaScript fallback message is English only.

### Fixed

- Outbound requests now validate the DNS addresses used by the actual connection,
  including streaming AI calls and redirects. IPv4-mapped IPv6 can no longer
  bypass private-network or metadata checks. Local AI endpoints remain supported.

- Docker and network deployments now require an access token for private pages
  and all private API reads as well as writes. A sign-in page provides access;
  missing configuration stays locked. Local launchers explicitly bind loopback.
  Cookie-authenticated mutations also require the full matching browser origin.
- JSON and file-upload limits now apply while reading the request, with a
  deadline and early cancellation. Oversized uploads return 413 and timed-out
  uploads return 408; backup and audit-bundle imports use the same bounded reader.

- CSV exports prefix formula-looking cells for spreadsheet viewing, including
  imported app and developer names. JSON exports retain the original values.

- CSV exports now keep column headings readable (`App Name`, `Last Synced`,
  `Privacy Type`) instead of replacing their spaces with `%20`.
- The activity log's type filter works for every event type again. It
  validated the requested type against a list that had fallen eight
  entries behind — so filtering by newer events (privacy-profile preset
  changes, verdicts, migrations, health checks) silently returned the
  *unfiltered* feed instead.
- The Stats page's policy radar no longer reshuffles which six apps it
  shows between visits: when several apps share the same last-synced
  time (which every bulk sync produces), the selection previously fell
  back to database scan order.
- Light-theme colour contrast on the app-detail page now meets WCAG AA:
  not-declared accessibility rows no longer dim their text below the
  threshold, the "Declared by developer" tag and the preference-key legend
  use theme-aware colours, the AI-policy note boxes no longer render dark
  navy in light mode, and the change-history chart's +N/−N counters use the
  theme palette instead of fixed chart-band colours.
- **Failed update checks now back off** instead of retrying forever. An
  installation with no internet access used to attempt a connection to
  GitHub — and wait out its timeout — every time anything asked whether an
  update was available. Consecutive failures now widen the gap between
  attempts (15 minutes, doubling, up to a day). Checking manually still
  makes a real attempt straight away.
- **The SQLite database is now private by default** — `0700` on the data
  directory, `0600` on the database and its write-ahead-log files. Existing
  installations are tightened automatically on their next start. The file
  holds your full app inventory, your notes, and (for now) any configured AI
  provider key.
- Accessible names restored for the icon-only home and "Add Apps" links in the
  compact navigation bar.
- Expandable section headers no longer nest their info-tooltip button inside
  the toggle, and the collapsed notes sidebar no longer keeps invisible
  controls in the tab order.
- The app-name entry field has a real label rather than only a placeholder.
- Colour contrast now meets WCAG AA across the interface: link and secondary
  text colours, the accent blue in light mode, and the navigation drawer were
  all below the 4.5:1 threshold in places.
- Nested panels — activity-log rows, the developer tools cards, and
  import-history banners — now have visible backgrounds. They were styled
  against `--surface-1/2/3` and `--border-1/2` design tokens that were never
  actually defined, so they rendered transparent. Defining those tokens for
  light, dark, high-contrast and reduce-transparency modes also clears the
  last dark-only boxes on the app-detail policy blocks (the scrollable source
  and trace wells) and in the Live Text illustration, which drew a dark phone
  frame in the light theme.
- Builds and lint now work from a git worktree nested under the main
  clone's `.claude/worktrees/`: `next.config.js` pins
  `outputFileTracingRoot` so `pnpm build:standalone` no longer emits
  `server.js` under a nested path, and `biome.jsonc` anchors its
  `.claude` exclusion at the repo root so `pnpm lint` stops reporting
  "Checked 0 files" there.

### Security

- Refresh the Docker and desktop Node runtime to 24.20.0, require patched Alpine TLS libraries, remove unused package managers from the runtime image, and apply compatible JavaScript/Rust dependency patches. Scan the final image in CI and track desktop runtime/scanner pins with Renovate.
- Documented in the README that a configured AI provider key is stored in
  plaintext in the local database. Moving desktop keys into the OS keychain is
  planned.

- Verify desktop backup artifacts before recording them and before uninstall pre-flight. Match native discovery to the selected device, use file-based freshness, reject invalid timestamps and symlinks, show the server's backup state throughout confirmation and retry flows, and stop Configurator process groups on timeout or excessive output.

## [0.1.2] — 2026-06-12

### Added

- Animated onboarding purpose cards and dashboard vignettes.
- Periodic health check with non-destructive self-heal for long-running
  instances.
- Read-only deployment mode for shared or kiosk installs.

### Changed

- Privacy-label icons and ordering aligned with Apple's own presentation.
- Full internationalisation sweep — the interface is translator-ready and
  round-trips through Crowdin.
- Onboarding hardening across the four import paths.

## [0.1.1] — 2026-05-20

### Fixed

- **Launch-time freeze affecting every copy of v0.1.0.** The bundled Node
  helper exited immediately with `MODULE_NOT_FOUND` for `@swc/helpers`,
  leaving an unresponsive window. The packaging step had dereferenced pnpm's
  symlinked `node_modules` layout, moving `@swc/helpers` out of Node's
  resolution path; it now preserves those relative symlinks verbatim through
  both staging and the release tarball.

  The auto-updater runs *after* the Node helper boots, so it never fired on
  v0.1.0 — anyone on that version had to install v0.1.1 manually. Every
  install from v0.1.1 onward self-updates normally.

## [0.1.0] — 2026-05-18

Initial beta release, available as a macOS app, a Docker image, or a plain
Next.js app.

### Added

- App Store privacy-label tracking with change detection over time.
- Historical back-fill to Q1 2021 via the Wayback Machine.
- Focus-tailored dashboard adapting to who the device belongs to (yourself, a
  loved one, or someone you support) and what you want from it.
- Four onboarding import paths: typed names, CSV/TXT upload, Apple
  Configurator on desktop, and screenshot OCR.
- Changelog timelines, privacy heatmap, per-app severity strips, an editable
  home-card layout, and exportable audit bundles.
- AI-generated privacy-policy summaries with a bring-your-own provider model.
- Background sync with a notifications bell, and crash-safe resume across the
  live, Wayback, and privacy-policy jobs.

[Unreleased]: https://github.com/privacykey/privacytracker/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/privacykey/privacytracker/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/privacykey/privacytracker/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/privacykey/privacytracker/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/privacykey/privacytracker/releases/tag/v0.1.0
