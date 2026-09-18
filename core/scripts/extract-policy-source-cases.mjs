/**
 * Policy-source oracle for the Rust core (Phase 5, batch 1).
 *
 * Runs the REAL `fetchPrivacyPolicySource` from `lib/privacy-policy.ts` —
 * the stateless fetch-and-extract pipeline the manual-app scrape route
 * also calls — with the raw `fetch` stubbed by recorded replies, never the
 * network, and records per case: every raw fetch Node made (URL and the
 * headers it set, one entry per redirect hop), every trace event the
 * pipeline emitted (what `last_run_log` will persist in batch 2), and the
 * validated source it returned or the error it threw with its structured
 * diagnostics.
 *
 * That covers the whole of the source layer: the locale rewrite of the
 * URL and its fallback, the Google locale pin, the three-tier fetch ladder
 * (direct, Chrome-header retry, Wayback snapshot) with its block codes and
 * retryable errors, the HTML-level redirects (meta refresh, script
 * location) and the Google consent wall with its bypass, the policy-link
 * second hop, HTML to text with the chrome stripping and entity decoding,
 * and the length and topic validation. Nothing here reads or writes the
 * database.
 *
 * The Rust replay feeds the same replies to the same transport loop, so
 * redirects and caps are exercised for real on both sides.
 */
process.env.TZ = "UTC";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "pt-policy-source-oracle-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = "1";
process.env.NEXT_PHASE = "phase-test";
process.env.WORKER_DISABLED = "1";
delete process.env.AUDITOR_ADMIN_TOKEN;

const { default: db } = await import("../../lib/db.ts");
const { fetchPrivacyPolicySource } = await import(
  "../../lib/privacy-policy.ts"
);

// ── Replies ──────────────────────────────────────────────────────────
const html = (body, headers = {}) => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
  body,
});
const plain = (body) => ({
  status: 200,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body,
});
const json = (body, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const status = (code, headers = {}) => ({ status: code, headers, body: "" });
const redirect = (location, code = 302) => status(code, { location });
const failure = (message) => ({ error: message });

// ── Pages ────────────────────────────────────────────────────────────
// Eight sentences, one per lens group, so a page built from them clears
// the topic-hit check; the section counter keeps repeats from collapsing.
const SENTENCES = [
  "We collect personal information such as your name, email address and device identifiers when you create an account.",
  "We use your information to provide, operate and improve the service and to personalize your experience.",
  "We share information with service providers and partners who process it on our behalf.",
  "We use cookies and analytics tools to understand how the app is used.",
  "You may request access to or deletion of your personal information at any time.",
  "We retain your information for as long as necessary to provide the service.",
  "Our service is not directed to children under 13.",
  "We do not use your information for interest-based advertising or marketing.",
];
const paragraphs = (count) =>
  Array.from(
    { length: count },
    (_, i) => `${SENTENCES[i % SENTENCES.length]} Section ${i + 1}.`
  );
const policyText = (count) => paragraphs(count).join("\n\n");
const policyHtml = (count) =>
  paragraphs(count)
    .map((p) => `<p>${p}</p>`)
    .join("\n");
// Enough words and characters to pass the length gate while hitting no
// lens keyword at all ("age" is a substring the check would find in
// "page" or "usage", so none of these words contains it).
const LOREM =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua";
const loremText = (reps) => Array.from({ length: reps }, () => LOREM).join(" ");

const CHROME = `<nav><a href="/">Home</a><a href="/privacy">Privacy</a></nav><header><h1>Example Inc</h1></header>`;
const FOOT =
  "<footer>&copy; 2026 Example Inc. All rights reserved.</footer><script>window.dataLayer = [];</script><style>.x{color:red}</style>";
const doc = (head, body) =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const TITLE = "<title>Example Privacy Policy</title>";
/** A complete policy page: chrome, a main block of `count` paragraphs, footer. */
const policyPage = (count = 30, head = TITLE) =>
  doc(head, `${CHROME}<main>${policyHtml(count)}</main>${FOOT}`);
const metaRefresh = (target, extra = "") =>
  doc(
    TITLE,
    `<meta http-equiv="refresh" content="0; url='${target}'">${extra}<main><p>Redirecting to our privacy policy.</p></main>`
  );
const jsRedirect = (statement) =>
  doc(TITLE, `<main><p>Loading.</p></main><script>${statement}</script>`);
const CONSENT = doc(
  "<title>Before you continue to Google</title>",
  `<div id="consent-bump"><h1>Before you continue to Google</h1><form action="https://consent.google.com/save"><button>I agree</button></form></div>`
);

const P = "https://example.com/privacy";
const AVAILABLE = (snapshot) =>
  json({
    url: P,
    archived_snapshots: {
      closest: {
        available: true,
        url: snapshot,
        timestamp: "20240101000000",
        status: "200",
      },
    },
  });
const SNAPSHOT =
  "http://web.archive.org/web/20240101000000/https://example.com/privacy";

// ── Driver ───────────────────────────────────────────────────────────
const quiet = ["error", "warn", "info", "log"];
function stubFetch(replies, calls) {
  let cursor = 0;
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: [...new Headers(init?.headers)],
    });
    const r = replies[cursor++];
    if (!r) {
      throw new Error(`Missing fixture reply for ${String(input)}`);
    }
    if (r.error) {
      throw new Error(r.error);
    }
    // A byte body, not a string: undici stamps `text/plain;charset=UTF-8`
    // on a string body with no Content-Type, which no server did. With
    // bytes the headers are exactly the reply's, as the Rust replay reads
    // them.
    const response = new Response(Buffer.from(r.body ?? "", "utf8"), {
      status: r.status,
      headers: r.headers,
    });
    // A synthetic Response has an empty `url`; undici's carries the
    // request URL of the hop that produced it, which is what the policy
    // layer reads as `finalUrl` after safeFetch's own redirect loop, and
    // what the Rust transport reports. Without this, every redirect in
    // the fixture would look like it landed on the requested URL.
    Object.defineProperty(response, "url", {
      value: String(input),
      configurable: true,
    });
    return response;
  };
  return () => {
    if (cursor !== replies.length) {
      throw new Error(`Unused replies: ${cursor}/${replies.length}`);
    }
  };
}

async function drive(target, replies) {
  const calls = [];
  const events = [];
  const check = stubFetch(replies, calls);
  const logger = {
    event(phase, opts = {}) {
      events.push({ phase, ...opts });
    },
  };
  const saved = quiet.map((k) => [k, console[k]]);
  for (const k of quiet) {
    console[k] = () => {};
  }
  let expected;
  try {
    const result = await fetchPrivacyPolicySource(target, logger);
    expected = { ok: true, result };
  } catch (error) {
    expected = {
      ok: false,
      error: {
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
        ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}),
      },
    };
  } finally {
    for (const [k, fn] of saved) {
      console[k] = fn;
    }
  }
  check();
  return { calls, events, expected };
}

const cases = [];
async function run(name, { url, replies }) {
  const { calls, events, expected } = await drive(url, replies);
  cases.push({ name, url, replies, calls, events, expected });
}

try {
  // ── Plain text ─────────────────────────────────────────────────────
  await run("plain text ready", {
    url: "https://www.example.com/privacy.txt",
    replies: [plain(policyText(30))],
  });
  await run("plain text too short", {
    url: P,
    replies: [plain("We collect nothing.")],
  });
  await run("plain text without policy clauses", {
    url: P,
    replies: [plain(loremText(22))],
  });
  await run("plain text with a byte order mark", {
    url: P,
    replies: [plain(`﻿${policyText(30)}`)],
  });

  // ── HTML extraction ────────────────────────────────────────────────
  await run("html main with chrome and title entities", {
    url: P,
    replies: [
      html(policyPage(30, "<title>Example &amp; Co &#8211; Privacy</title>")),
    ],
  });
  await run("html article fallback", {
    url: P,
    replies: [
      html(doc(TITLE, `${CHROME}<article>${policyHtml(30)}</article>${FOOT}`)),
    ],
  });
  await run("html body fallback", {
    url: P,
    replies: [html(doc(TITLE, `${CHROME}${policyHtml(30)}${FOOT}`))],
  });
  await run("html without a body tag", {
    url: P,
    replies: [html(`${TITLE}${policyHtml(30)}`)],
  });
  await run("chrome stripped by role, class, odd closers and nesting", {
    url: P,
    replies: [
      html(
        doc(
          TITLE,
          [
            `<div class="cookie-banner">Accept cookies to continue browsing this site.</div>`,
            `<div role="navigation"><a href="/">Home</a></div>`,
            "<main>",
            `<div class="sidebar-wrap"><div class="content">INNER SIDEBAR TEXT</div>OUTER TAIL</div>`,
            `<script type="text/javascript">window.location.hash = "x";</script foo="bar">`,
            `<noscript>Enable JavaScript.</noscript><svg><title>icon</title></svg><form><input name="q"></form>`,
            policyHtml(30),
            "</main>",
            `<div class="menu"><span>Unclosed menu block`,
            FOOT,
          ].join("\n")
        )
      ),
    ],
  });
  await run("second pass picks the longest policy container", {
    url: P,
    replies: [
      html(
        doc(
          TITLE,
          [
            "<main><p>Welcome to our legal centre.</p></main>",
            `<section class="legal-text">${policyHtml(20)}</section>`,
            `<div class="policy sidebar">${policyHtml(40)}</div>`,
            `<div id="privacy-policy-content">${policyHtml(30)}</div>`,
          ].join("\n")
        )
      ),
    ],
  });
  await run("block tags, entities and whitespace normalised", {
    url: P,
    replies: [
      html(
        doc(
          TITLE,
          `<main><h1>Privacy &amp; Cookies</h1><ul><li>Item one</li><li>Item two</li></ul><table><tr><td>Cell A</td><td>Cell B</td></tr></table><blockquote>Quoted&hellip;</blockquote><p>Line one<br>Line two<br/>Tab\there   spaced &nbsp; nbsp &#x27;hex&#39;dec &unknown; &lt;b&gt; &#8212; dash</p>\r\n\r\n\r\n\r\n${policyHtml(30)}</main>`
        )
      ),
    ],
  });
  await run("entity code point overflow throws", {
    url: P,
    replies: [
      html(
        doc(TITLE, `<main><p>Bad &#1114112; entity</p>${policyHtml(30)}</main>`)
      ),
    ],
  });
  await run("empty content type is treated as html", {
    url: P,
    replies: [{ status: 200, headers: {}, body: policyPage() }],
  });
  await run("unsupported content type", {
    url: P,
    replies: [
      {
        status: 200,
        headers: { "content-type": "application/pdf" },
        body: "%PDF-1.4",
      },
    ],
  });
  await run("xhtml content type", {
    url: P,
    replies: [html(policyPage(), { "content-type": "application/xhtml+xml" })],
  });

  // ── HTML-level redirects ───────────────────────────────────────────
  await run("meta refresh hop with a quoted url", {
    url: P,
    replies: [
      html(metaRefresh("https://example.com/privacy/full")),
      html(policyPage()),
    ],
  });
  await run("meta refresh hop with a bare relative url", {
    url: P,
    replies: [
      html(
        doc(
          TITLE,
          `<meta http-equiv=refresh content="5;URL=/legal/privacy"><main><p>Moved.</p></main>`
        )
      ),
      html(policyPage()),
    ],
  });
  await run("script location replace hop", {
    url: P,
    replies: [
      html(jsRedirect(`window.location.replace("https://example.com/p2");`)),
      html(policyPage()),
    ],
  });
  await run("script document location hop", {
    url: P,
    replies: [
      html(jsRedirect(`document.location = '/p3';`)),
      html(policyPage()),
    ],
  });
  await run("redirect chain capped at three hops", {
    url: P,
    replies: [
      html(metaRefresh("https://example.com/h1")),
      html(metaRefresh("https://example.com/h2")),
      html(metaRefresh("https://example.com/h3")),
      html(
        doc(
          TITLE,
          `<meta http-equiv="refresh" content="0; url=https://example.com/h4">${CHROME}<main>${policyHtml(30)}</main>`
        )
      ),
    ],
  });
  await run("redirect loop stops on a visited url", {
    url: P,
    replies: [
      html(metaRefresh("https://example.com/b")),
      html(metaRefresh(P, "<main><p>Bounce.</p></main>")),
    ],
  });
  await run("redirect to non-html stops the chain", {
    url: P,
    replies: [
      html(metaRefresh("https://example.com/policy.pdf")),
      {
        status: 200,
        headers: { "content-type": "application/pdf" },
        body: "%PDF-1.4",
      },
    ],
  });
  await run("redirect target failure keeps the current page", {
    url: P,
    replies: [html(metaRefresh("https://example.com/gone")), status(404)],
  });
  await run("same-url and javascript refresh targets are ignored", {
    url: P,
    replies: [
      html(
        doc(
          TITLE,
          `<meta http-equiv="refresh" content="0; url=${P}"><meta http-equiv="refresh" content="0; url=javascript:alert(1)">${CHROME}<main>${policyHtml(30)}</main>`
        )
      ),
    ],
  });
  await run("redirect hop upgrades the source origin", {
    url: P,
    replies: [
      html(jsRedirect(`location.href = "https://example.com/p2";`)),
      status(403),
      html(policyPage()),
    ],
  });

  // ── Google ─────────────────────────────────────────────────────────
  await run("google policy url is pinned before the first fetch", {
    url: "https://policies.google.com/privacy",
    replies: [html(policyPage())],
  });
  await run("google url already pinned is fetched as is", {
    url: "https://policies.google.com/privacy?hl=en-GB&gl=US",
    replies: [html(policyPage())],
  });
  await run("consent wall bypassed through its continue url", {
    url: "https://policies.google.com/privacy",
    replies: [
      redirect(
        "https://consent.google.com/m?continue=https%3A%2F%2Fpolicies.google.com%2Fprivacy"
      ),
      html(CONSENT),
      html(policyPage()),
    ],
  });
  await run("consent continue to a non-google host is ignored", {
    url: "https://policies.google.com/privacy",
    replies: [
      redirect(
        "https://consent.google.com/m?continue=https%3A%2F%2Fevil.example%2F"
      ),
      html(CONSENT),
    ],
  });
  await run("consent markup on a google host without continue", {
    url: "https://www.google.com/intl/en/policies/privacy/",
    replies: [html(CONSENT), html(policyPage())],
  });
  await run("consent bypass returning non-html is kept out", {
    url: "https://policies.google.com/privacy",
    replies: [
      redirect(
        "https://consent.google.com/m?continue=https%3A%2F%2Fpolicies.google.com%2Fprivacy"
      ),
      html(CONSENT),
      {
        status: 200,
        headers: { "content-type": "application/pdf" },
        body: "%PDF-1.4",
      },
    ],
  });
  await run("consent bypass fetch failure is logged", {
    url: "https://policies.google.com/privacy",
    replies: [
      redirect(
        "https://consent.google.com/m?continue=https%3A%2F%2Fpolicies.google.com%2Fprivacy"
      ),
      html(CONSENT),
      status(404),
    ],
  });

  // ── Language normalisation ─────────────────────────────────────────
  await run("locale path rewritten then original on failure", {
    url: "https://example.com/zh/legal/privacy",
    replies: [status(404), html(policyPage())],
  });
  await run("locale path with region rewritten", {
    url: "https://example.com/zh-CN/privacy",
    replies: [html(policyPage())],
  });
  await run("locale query rewritten and query re-serialised", {
    url: "https://example.com/privacy?q=a%20b&lang=fr",
    replies: [html(policyPage())],
  });
  await run("unknown codes are left alone", {
    url: "https://example.com/xx/privacy?lang=shortform",
    replies: [html(policyPage())],
  });
  await run("three letter language code rewritten", {
    url: "https://example.com/fil/privacy",
    replies: [html(policyPage())],
  });

  // ── The fetch ladder ───────────────────────────────────────────────
  await run("404 is final", { url: P, replies: [status(404)] });
  await run("403 then the browser retry succeeds", {
    url: P,
    replies: [status(403), html(policyPage())],
  });
  await run("401 then the browser retry succeeds", {
    url: P,
    replies: [status(401), html(policyPage())],
  });
  await run("blocked twice then the wayback snapshot", {
    url: P,
    replies: [
      status(403),
      status(403),
      AVAILABLE(SNAPSHOT),
      html(policyPage()),
    ],
  });
  await run("blocked twice and no wayback snapshot", {
    url: P,
    replies: [
      status(429),
      status(503),
      json({ url: P, archived_snapshots: {} }),
    ],
  });
  await run("wayback availability not json", {
    url: P,
    replies: [status(403), status(403), json("<html>not json</html>")],
  });
  await run("wayback snapshot fetch not ok", {
    url: P,
    replies: [status(403), status(403), AVAILABLE(SNAPSHOT), status(503)],
  });
  await run("retryable network error then the browser retry", {
    url: P,
    replies: [failure("ECONNRESET"), html(policyPage())],
  });
  await run("timeout is retryable", {
    url: P,
    replies: [
      failure("The operation was aborted due to timeout"),
      html(policyPage()),
    ],
  });
  await run("declared content length over the cap is final", {
    url: P,
    replies: [
      {
        status: 200,
        headers: { "content-type": "text/html", "content-length": "99999999" },
        body: "<p>x</p>",
      },
    ],
  });
  await run("too many redirects is final", {
    url: P,
    replies: Array.from({ length: 6 }, (_, i) =>
      redirect(`https://example.com/r${i + 1}`)
    ),
  });
  await run("http redirect followed", {
    url: P,
    replies: [
      redirect("https://example.com/legal/privacy", 301),
      html(policyPage()),
    ],
  });
  await run("browser retry failure is final", {
    url: P,
    replies: [status(403), failure("unexpected TLS handshake")],
  });
  await run("refused private url", {
    url: "http://127.0.0.1/privacy",
    replies: [],
  });
  await run("refused scheme", {
    url: "ftp://example.com/privacy",
    replies: [],
  });

  // ── The policy-link second hop ─────────────────────────────────────
  const INDEX = doc(
    TITLE,
    `${CHROME}<main><p>Welcome. Read our <a href="/legal/privacy-policy">full Privacy Policy</a>.</p></main>${FOOT}`
  );
  await run("short page follows its privacy policy link", {
    url: P,
    replies: [html(INDEX), html(policyPage())],
  });
  await run("followed page shorter keeps the original", {
    url: P,
    replies: [html(INDEX), html(doc(TITLE, "<main><p>Short.</p></main>"))],
  });
  await run("cross-host policy link not followed", {
    url: P,
    replies: [
      html(
        doc(
          TITLE,
          `<main><p>See <a href="https://legal.example.org/privacy-policy">Privacy Policy</a>.</p></main>`
        )
      ),
    ],
  });
  await run("followed link http error", {
    url: P,
    replies: [html(INDEX), status(404)],
  });
  await run("followed link rejected as too long", {
    url: P,
    replies: [
      html(
        doc(
          TITLE,
          `<main><p>See <a href="/${"a".repeat(3000)}">Privacy Policy</a>.</p></main>`
        )
      ),
    ],
  });
  await run("followed link locale normalised", {
    url: "https://example.com/zh/",
    replies: [
      status(404),
      html(
        doc(
          TITLE,
          `<main><p>See <a href="/zh/privacy-policy">Privacy Policy</a>.</p></main>`
        )
      ),
      html(policyPage()),
    ],
  });
  await run("short page with no policy link", {
    url: P,
    replies: [html(doc(TITLE, "<main><p>Nothing to see here.</p></main>"))],
  });
  await run("policy link to the current page is skipped", {
    url: P,
    replies: [
      html(
        doc(
          TITLE,
          `<main><p>See <a href="/privacy">Privacy Policy</a>.</p></main>`
        )
      ),
    ],
  });

  const text = `${JSON.stringify({ cases }, null, 2)}\n`;
  writeFileSync(
    new URL("../tests/fixtures/policy-source-cases.json", import.meta.url),
    text
  );
  console.log(
    `Recorded ${cases.length} actual Node policy-source cases from fetchPrivacyPolicySource; no network.`
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
