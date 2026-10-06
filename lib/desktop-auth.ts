/**
 * The desktop app's launch credential, for the Node sidecar build.
 *
 * The desktop app serves this server on a loopback port with no admin
 * token. The loopback bind keeps the network out, but not the rest of the
 * machine: any process under any account could read the library over HTTP,
 * and a mutation needs only an `Origin` that matches its `Host`, which a
 * non-browser client writes itself (fingerprint
 * `src-tauri/sidecar/loopback-api-no-per-launch-credential`). So the shell
 * mints a fresh random credential on every launch and hands it to the
 * sidecar in `PRIVACYTRACKER_DESKTOP_TOKEN`. While it is set, every `/api/*`
 * request must present it, as the `X-PrivacyTracker-Desktop-Token` header
 * or as the `pt_desktop_session` cookie; the page shells stay public, as
 * they are the same static files for everyone and hold no data.
 *
 * It is deliberately not `AUDITOR_ADMIN_TOKEN`: the frontend reads a
 * configured admin token as a network deployment (pages redirect to
 * `/login`, Settings shows the unlock card, the dev routes switch on). This
 * mode touches none of that.
 *
 * The window gets its cookie from a one-time link. The shell mints a
 * bootstrap nonce beside the credential and passes it in
 * `PRIVACYTRACKER_DESKTOP_BOOTSTRAP_NONCE`, then opens
 * `/api/desktop/bootstrap?nonce=…`; the proxy answers that link itself,
 * once and within `BOOTSTRAP_TTL_MS` of the server reading it, with an
 * `HttpOnly; SameSite=Strict` cookie scoped to `/api` and a redirect to
 * `/`, so the credential never appears in a URL the page keeps, in
 * `document.cookie` or in history. A window that already holds the cookie
 * is sent on without a new one.
 *
 * `core/src/server/desktop_auth.rs` is the Rust server's version of this
 * module; the Rust shell issues its nonces in process, this one receives
 * the sidecar's single nonce through the environment. Web and Docker never
 * set the variable, so nothing changes there, and the parity harnesses
 * never see this mode: the link is answered by the proxy, not routed, so
 * there is no `app/api` file for the manifest to classify.
 *
 * Nothing here touches the database: the proxy sandbox cannot load it.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** The host-environment variable the shell passes the credential in. */
export const DESKTOP_CREDENTIAL_ENV = "PRIVACYTRACKER_DESKTOP_TOKEN";
/** The variable the shell passes the one-time link's nonce in. */
export const DESKTOP_BOOTSTRAP_NONCE_ENV =
  "PRIVACYTRACKER_DESKTOP_BOOTSTRAP_NONCE";
/** The header a same-user tool (or the shell itself) sends it in. */
export const DESKTOP_CREDENTIAL_HEADER = "x-privacytracker-desktop-token";
/** The cookie the webview carries it in, set by the one-time link. */
export const DESKTOP_SESSION_COOKIE = "pt_desktop_session";
/** The one-time link. Answered by the proxy, never routed. */
export const DESKTOP_BOOTSTRAP_PATH = "/api/desktop/bootstrap";
/** How long a one-time link stays usable after the server learns of it. */
export const BOOTSTRAP_TTL_MS = 60_000;
/** Links issued and not yet used; bounds a caller that issues in a loop. */
const MAX_PENDING = 16;

export const DESKTOP_CREDENTIAL_REQUIRED = "Desktop credential required";
export const DESKTOP_LINK_REFUSED = "Sign-in link expired or already used";

interface Nonces {
  pending: Array<{ nonce: string; issuedAt: number }>;
  /** Whether the environment's nonce has been taken into `pending`. */
  seeded: boolean;
}

const NONCES = Symbol.for("privacytracker.desktop-bootstrap-nonces");

function nonces(): Nonces {
  const g = globalThis as { [NONCES]?: Nonces };
  g[NONCES] ??= { pending: [], seeded: false };
  return g[NONCES];
}

/** Test hook: forget every pending link, including the environment's. */
export function _resetDesktopBootstrapNonces(): void {
  const g = globalThis as { [NONCES]?: Nonces };
  delete g[NONCES];
}

/**
 * The launch credential, when this server was given one. An empty value
 * counts as none, as an empty admin token does.
 */
export function desktopCredential(): string | null {
  const value = process.env[DESKTOP_CREDENTIAL_ENV];
  return value ? value : null;
}

/**
 * Whether `provided` is `expected`, in time that depends on neither: both
 * are hashed first, so the comparison always runs over two 32-byte digests
 * and a guess of the wrong length takes as long as one of the right length.
 */
function sameSecret(provided: string, expected: string): boolean {
  if (!(provided && expected)) {
    return false;
  }
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The credential in the header. The one form that also stands in for a
 * matching `Origin` on a mutation, as the admin-token header does: a
 * browser cannot attach it to a cross-site request. Several header values
 * arrive joined by commas; the credential is hex, so each part is tried.
 */
export function desktopHeaderPresented(
  headers: Headers,
  credential: string
): boolean {
  const raw = headers.get(DESKTOP_CREDENTIAL_HEADER);
  if (!raw) {
    return false;
  }
  return raw.split(",").some((part) => sameSecret(part.trim(), credential));
}

/**
 * The credential in the session cookie. Every cookie of that name is
 * tried, not just the first: a stale one from an earlier launch must not
 * shadow the current one.
 */
function desktopCookiePresented(headers: Headers, credential: string): boolean {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== DESKTOP_SESSION_COOKIE) {
      continue;
    }
    if (sameSecret(part.slice(separator + 1).trim(), credential)) {
      return true;
    }
  }
  return false;
}

/** The credential in either form. */
export function desktopCredentialPresented(
  headers: Headers,
  credential: string
): boolean {
  return (
    desktopHeaderPresented(headers, credential) ||
    desktopCookiePresented(headers, credential)
  );
}

/**
 * The `Set-Cookie` the one-time link answers with: session-only (gone when
 * the app quits, like the credential itself), unreadable by page scripts,
 * never sent on a cross-site request, and scoped to the API, which is all
 * it is for.
 */
export function desktopSessionCookie(credential: string): string {
  return `${DESKTOP_SESSION_COOKIE}=${credential}; Path=/api; HttpOnly; SameSite=Strict`;
}

function prune(state: Nonces, now: number): void {
  state.pending = state.pending.filter(
    ({ issuedAt }) => now - issuedAt < BOOTSTRAP_TTL_MS
  );
}

/**
 * Take the shell's nonce from the environment the first time any link is
 * looked at. Its clock starts then, which is a few seconds after the shell
 * minted it; the shell opens the link as soon as the server answers.
 */
function seedFromEnvironment(state: Nonces, now: number): void {
  if (state.seeded) {
    return;
  }
  state.seeded = true;
  const nonce = process.env[DESKTOP_BOOTSTRAP_NONCE_ENV];
  if (nonce) {
    issueDesktopBootstrapNonce(nonce, now);
  }
}

/** Add a one-time link; a harness's way of standing in for the shell. */
export function issueDesktopBootstrapNonce(
  nonce: string,
  now = Date.now()
): void {
  const state = nonces();
  prune(state, now);
  if (state.pending.length >= MAX_PENDING) {
    state.pending.shift();
  }
  state.pending.push({ nonce, issuedAt: now });
}

/**
 * Use `candidate` up: true once for a link issued less than
 * `BOOTSTRAP_TTL_MS` ago, false for anything else, including the same link
 * a second time. Every pending link is compared, so where a match sits in
 * the list is not timed.
 */
function redeem(candidate: string, now: number): boolean {
  const state = nonces();
  seedFromEnvironment(state, now);
  prune(state, now);
  let found = -1;
  state.pending.forEach(({ nonce }, index) => {
    if (sameSecret(candidate, nonce)) {
      found = index;
    }
  });
  if (found < 0) {
    return false;
  }
  state.pending.splice(found, 1);
  return true;
}

/** `/api` and everything under it: what handlers serve. */
function isApi(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export type DesktopDecision =
  /** Not the API, or the API with the credential: carry on through the gate. */
  | { kind: "pass" }
  /** The API without the credential: 401. */
  | { kind: "refused" }
  /**
   * The one-time link, used: a redirect to the start page, with the session
   * cookie when the link itself was good (a window that already holds the
   * cookie is sent on without a new one).
   */
  | { kind: "signed_in"; setCookie: string | null }
  /** The one-time link, expired or already used, from a client holding no credential: 403. */
  | { kind: "link_refused" };

/**
 * The desktop step of the proxy, for a server whose launch credential is
 * `credential`. `core/src/server/desktop_auth.rs`'s `decide`.
 */
export function decideDesktopCredential(
  method: string,
  pathname: string,
  nonce: string | null,
  headers: Headers,
  credential: string,
  now = Date.now()
): DesktopDecision {
  if (pathname === DESKTOP_BOOTSTRAP_PATH && method === "GET") {
    if (nonce !== null && redeem(nonce, now)) {
      return { kind: "signed_in", setCookie: desktopSessionCookie(credential) };
    }
    if (desktopCredentialPresented(headers, credential)) {
      return { kind: "signed_in", setCookie: null };
    }
    return { kind: "link_refused" };
  }
  if (isApi(pathname) && !desktopCredentialPresented(headers, credential)) {
    return { kind: "refused" };
  }
  return { kind: "pass" };
}
