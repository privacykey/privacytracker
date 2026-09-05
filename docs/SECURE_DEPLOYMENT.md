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

`pnpm dev` and `pnpm start` bind `127.0.0.1` explicitly. The desktop sidecar does the
same. These local listeners can run without a token; setting a token opts them
into authentication too. To listen on another interface, use for example
`pnpm start --hostname 0.0.0.0` and configure the token and allowed hosts.

The launcher passes the actual bind to the security checks. Custom launchers must
keep `PRIVACYTRACKER_BIND_HOST` consistent with the real listener. An unknown or
wildcard bind requires authentication. `HOSTNAME` alone is not a trusted bind
signal. Never claim a loopback bind for a listener reachable on other interfaces.
