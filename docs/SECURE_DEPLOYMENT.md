# Secure deployment

privacytracker holds your app inventory, private notes and AI provider credentials.
The shared access token grants full access to that workspace. It is a single-user
application; anyone you give the token to has the same permissions as you.

## Docker: configure a token before upgrading or starting

Even with `127.0.0.1:3000:3000` on the host, other containers on the same Docker
network can reach the application. Docker therefore always requires a token.
An image started without one serves health checks and the sign-in page, but keeps
private data and mutations locked. Existing installations must configure a token
before upgrading to this version; their data volume stays intact.

From the directory containing your Compose file, generate a random token:

```sh
openssl rand -hex 32
```

Create or edit the gitignored `.env` file (do not overwrite existing settings):

```dotenv
AUDITOR_ADMIN_TOKEN=replace-with-the-generated-token
```

Restrict that file with `chmod 600 .env`, then start `docker compose up --build -d`.
Open http://127.0.0.1:3000 and enter the token. The browser receives an HttpOnly,
SameSite=Strict cookie valid for eight hours. Rotating the server token invalidates
all existing cookies. Keep the token out of URLs, screenshots and source control.
Scripts authenticate using the `x-auditor-admin-token` request header.

## LAN and reverse proxies

Use HTTPS for LAN access, including on a home network. Configure
`PRIVACYTRACKER_ALLOWED_HOSTS` with the hostname you use in the browser; loopback
remains allowed for health checks. Host allowlisting prevents DNS rebinding but
does not replace authentication.

The Caddy example in `deploy/caddy/compose.yaml` supplies the required host,
network and proxy settings. Set `PRIVACYTRACKER_HOST` and `AUDITOR_ADMIN_TOKEN` in
that Compose directory's `.env`. Trust Caddy's local CA on your devices when using
its local HTTPS certificates. The Traefik example is HTTP-only: add your TLS
configuration before using it across a LAN.

Set `PRIVACYTRACKER_TRUST_PROXY=1` only when the upstream proxy overwrites
`X-Forwarded-Host`, `X-Forwarded-Proto` and appends the real client address to
`X-Forwarded-For`. Limit access to the app's Docker network to the proxy and trusted
services. Do not publish the app port separately when using these examples.
Browser mutations must match the complete public origin, including scheme and
port. Cookies do not bypass this check; explicit token headers support scripts.

## Running directly and the desktop app

`pnpm dev` and `pnpm start` bind `127.0.0.1` explicitly, as does the Rust server
(`pt-core serve`) unless given `--host`, and the desktop app does the same. These
local listeners can run without a token; setting a token opts them into
authentication too. To listen on another interface, use for example
`pnpm start --hostname 0.0.0.0` or `pt-core serve --host 0.0.0.0`, and configure
the token and allowed hosts.

The desktop app adds its own lock, because a loopback address keeps the network
out but not other programs on the same Mac. Every launch mints a new random
credential and its server refuses every `/api` request that does not carry it,
as the `X-PrivacyTracker-Desktop-Token` header or as the session cookie the app
window receives through a one-time sign-in link. The pages themselves stay
public; they hold no data. A tool running as the same user reads the credential
from `.desktop-token` in the app-data directory (`0600`, rewritten every launch
and removed on quit; the port is in `.desktop-port`). The credential is not an
admin token, and the desktop app shows no sign-in page. The Node rollback build
of the desktop app does not have this lock.

Both launchers pass the actual bind to the security checks. Custom launchers must
keep `PRIVACYTRACKER_BIND_HOST` consistent with the real listener. An unknown or
wildcard bind requires authentication. `HOSTNAME` alone is not a trusted bind
signal. Never claim a loopback bind for a listener reachable on other interfaces.
`pt-core serve` refuses options it does not know rather than ignoring them, so a
mistyped host cannot leave it listening somewhere other than intended.

## Request limits

The Docker image and the desktop app run the Rust server, which limits each
request body by route: 4 KiB for sign-in, 512 KiB for ordinary requests, 8 MiB
for audit bundles and 100 MiB for backup preview/restore, with a 30-second upload
deadline. It reads a body only after the request has passed authentication and
the origin check, so an anonymous client on the network cannot upload anything:
an oversized anonymous upload is answered 401, where the Node server answers 413.
A client also has 60 seconds to send its request headers, as with Node. Reverse
proxies should set matching or smaller upload limits and deadlines.

## Custom Node launchers

The Node server (`pnpm start`, and the rollback image built with
`--build-arg BACKEND=node`) needs `lib/request-limits.cjs` loaded before Next.
The supplied `pnpm start`, `pnpm dev`, Node image command and staged sidecar entry
point do this automatically.
It limits raw HTTP uploads before Next Proxy clones their bodies: 4 KiB for
sign-in, 512 KiB for ordinary requests, 8 MiB for audit bundles and 100 MiB for
backup preview/restore, with a 30-second upload deadline. The larger import limits
require authentication or an explicitly local default deployment; anonymous network
requests retain the ordinary cap. Routes apply their
own smaller limits too. Bare `next start` bypasses this entry-point protection.
Reverse proxies should set matching or smaller upload limits and deadlines.

## Content Security Policy

The app emits its own strict CSP on every response — in the Docker image and
in the desktop app alike — so it does **not** depend on a reverse proxy
for it. The policy is hash-based: `pnpm build` runs
`scripts/generate-csp-hashes.mjs`, which hashes each prerendered page's inline
scripts into `.next/csp-hashes.json` and fails the build if any page stopped
prerendering. The server sends the matching hashes per route (`proxy.ts` in
Node, the same rules in the Rust server). Both log an error when the build has
no `csp-hashes.json`: Node on the first page it serves, the Rust server at
startup.

`PRIVACYTRACKER_CSP` controls the mode: `enforce` (default), `report-only`
(sends `Content-Security-Policy-Report-Only` so you can watch what *would* be
blocked), or `off` (no CSP — debugging only). Violations the browser reports
land at `POST /api/csp-report` (public, rate limited, in-memory only) and are
listed on the Diagnostics page; nothing leaves the machine.

If you front the app with a reverse proxy, **do not strip or replace** its
`Content-Security-Policy` header — add TLS/HSTS at the proxy and let the app
keep its own policy.
