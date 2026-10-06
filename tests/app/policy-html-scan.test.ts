import assert from "node:assert/strict";
import test from "node:test";
import {
  blockTagsToText,
  findTagBlocks,
  firstTagBlockInner,
  metaRefreshUrl,
  policyContainers,
  privacyPolicyLinkHref,
  scriptBlocks,
  sliceParagraph,
  stripClassContainers,
  stripRoleBlocks,
  stripTagBlocks,
} from "../../lib/policy-html-scan";
import {
  chunkPolicyText,
  extractPolicyTextFromHtml,
} from "../../lib/privacy-policy";

// ── Reference implementations: the regexes the scanners replaced ─────────
//
// These are the patterns `lib/privacy-policy.ts` ran before the scanners,
// verbatim. They are fine on short strings, which is all the fuzz below
// hands them; on a crafted page they backtrack for seconds per megabyte,
// which is why they are no longer in production code.

const CHROME_CLASS_PATTERN =
  /(cookie|consent|banner|navbar|nav-|menu|footer|subscribe|signup|breadcrumb|hero-|cta-|sidebar|social|related|share|toolbar|modal|popup)/i;

function blockPattern(name: string, flags: string): RegExp {
  return new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\b[^>]*>`, flags);
}

function refStripTagBlocks(html: string, name: string): string {
  return html.replace(blockPattern(name, "gi"), " ");
}

function refFirstTagBlockInner(html: string, name: string): string | null {
  return html.match(blockPattern(name, "i"))?.[1] ?? null;
}

function refStripRoleBlocks(html: string): string {
  return html.replace(
    /<[^>]+\srole="(navigation|banner|contentinfo|complementary|search)"[^>]*>[\s\S]*?<\/[^>]+\s*>/gi,
    " "
  );
}

/** Node's class-container regex, exactly: the backtracking reference. */
function regexStripClassContainers(html: string): string {
  return html.replace(
    /<(div|section|aside|header|footer|ul|ol)\b[^>]*\sclass="[^"]*"[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi,
    (full) => {
      const classMatch = full.match(/\sclass="([^"]*)"/i);
      if (classMatch && CHROME_CLASS_PATTERN.test(classMatch[1])) {
        return " ";
      }
      return full;
    }
  );
}

/**
 * The Rust core's `strip_class_containers`, ported plainly (and
 * quadratically): the opener regex on its own, the first closer of that
 * name from the opener's end, a miss resuming one character on.
 */
function rustStripClassContainers(html: string): string {
  const open =
    /<(div|section|aside|header|footer|ul|ol)\b[^>]*\sclass="[^"]*"[^>]*>/gi;
  let out = "";
  let copied = 0;
  let searchFrom = 0;
  for (;;) {
    open.lastIndex = searchFrom;
    const opener = open.exec(html);
    if (!opener) {
      break;
    }
    const tag = opener[1].toLowerCase();
    const closer = new RegExp(`<\\/${tag}\\b[^>]*>`, "gi");
    closer.lastIndex = opener.index + opener[0].length;
    const close = closer.exec(html);
    if (!close) {
      searchFrom = opener.index + 1;
      continue;
    }
    const end = close.index + close[0].length;
    const full = html.slice(opener.index, end);
    out += html.slice(copied, opener.index);
    const classMatch = full.match(/\sclass="([^"]*)"/i);
    out += classMatch && CHROME_CLASS_PATTERN.test(classMatch[1]) ? " " : full;
    copied = end;
    searchFrom = end;
  }
  return out + html.slice(copied);
}

/** Node's second-pass container `exec` loop, exactly. */
function regexPolicyContainers(html: string): [string, string][] {
  const containerRegex =
    /<(div|section|article|main)\b[^>]*\s(?:id|class)="([^"]*(?:policy|privacy|legal|terms|content|main|body|document)[^"]*)"[^>]*>([\s\S]*?)<\/\1>/gi;
  const out: [string, string][] = [];
  let match = containerRegex.exec(html);
  while (match !== null) {
    out.push([match[2], match[3]]);
    match = containerRegex.exec(html);
  }
  return out;
}

/** The Rust core's second-pass scanner, ported plainly. */
function rustPolicyContainers(html: string): [string, string][] {
  const open =
    /<(div|section|article|main)\b[^>]*\s(?:id|class)="([^"]*(?:policy|privacy|legal|terms|content|main|body|document)[^"]*)"[^>]*>/gi;
  const out: [string, string][] = [];
  let searchFrom = 0;
  for (;;) {
    open.lastIndex = searchFrom;
    const opener = open.exec(html);
    if (!opener) {
      break;
    }
    const tag = opener[1].toLowerCase();
    const closer = new RegExp(`<\\/${tag}>`, "gi");
    const openEnd = opener.index + opener[0].length;
    closer.lastIndex = openEnd;
    const close = closer.exec(html);
    if (!close) {
      searchFrom = opener.index + 1;
      continue;
    }
    out.push([opener[2], html.slice(openEnd, close.index)]);
    searchFrom = close.index + close[0].length;
  }
  return out;
}

function refBlockTagsToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|li|section|article|main|header|h[1-6]|tr|td|blockquote|ul|ol)>/gi,
      "\n"
    )
    .replace(
      /<(p|div|li|section|article|main|header|h[1-6]|tr|td|blockquote|ul|ol)[^>]*>/gi,
      "\n"
    )
    .replace(/<[^>]+>/g, " ");
}

function refMetaRefreshUrl(html: string): string | null {
  return (
    html.match(
      /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']\s*\d+\s*;\s*url\s*=\s*(?:["']?)([^"'>\s]+)(?:["']?)/i
    )?.[1] ?? null
  );
}

function refScriptBlocks(html: string): string[] {
  return html.match(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi) ?? [];
}

function refPrivacyPolicyLinkHref(html: string): string | null {
  return (
    html.match(
      /<a\s+[^>]*href="([^"#?]+(?:\?[^"#]*)?)"[^>]*>\s*(?:(?:read|view|see|open)[^<]*)?(?:full|complete|detailed)?\s*(?:privacy\s*(?:policy|notice|statement))[^<]*<\/a>/i
    )?.[1] ?? null
  );
}

function refSliceParagraph(paragraph: string, n: number): string[] {
  return paragraph.match(new RegExp(`[\\s\\S]{1,${n}}(?:\\s|$)`, "g")) ?? [];
}

// ── Fuzz corpus ─────────────────────────────────────────────────────────

/** A small deterministic PRNG (mulberry32) so a failure reproduces. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fragments chosen to hit every branch of every pattern: tag names in both
// cases, closers with and without attributes, word-boundary spoilers,
// quotes of both kinds, the landmark roles, chrome and policy class names,
// refresh attributes, link text, JavaScript whitespace outside ASCII.
const TOKENS = [
  "<",
  ">",
  "/",
  '"',
  "'",
  "=",
  " ",
  "  ",
  "\n",
  "\t",
  " ",
  " ",
  "a",
  "x",
  "Z",
  "_",
  "1",
  "0",
  ";",
  "?",
  "#",
  "&",
  "<script",
  "<SCRIPT>",
  "<script>",
  "<scripts>",
  "</script>",
  "</script >",
  '</script foo="bar">',
  "</ScRiPt",
  "<style>",
  "</style>",
  "<noscript>",
  "</noscript>",
  "<svg>",
  "</svg>",
  "<nav>",
  "</nav>",
  "<header",
  "<header>",
  "</header>",
  "<aside>",
  "</aside>",
  "<footer>",
  "</footer>",
  "<form>",
  "</form>",
  "<div",
  "<div>",
  "</div>",
  "</div >",
  "</divx>",
  "<section",
  "</section>",
  "<ul",
  "</ul>",
  "<ol>",
  "</ol>",
  "<li>",
  "</li>",
  "<p",
  "<p>",
  "</p>",
  "<pre>",
  "<main",
  "<main>",
  "</main>",
  "<article>",
  "</article>",
  "<body>",
  "</body>",
  "<title>",
  "</title>",
  "<h1>",
  "</h1>",
  "<h7>",
  "<hr>",
  "<tr>",
  "<td>",
  "</td>",
  "<blockquote>",
  "<br>",
  "<br/>",
  "<br />",
  "<br class=x>",
  "<meta",
  "<meta>",
  "<a",
  "<a ",
  "<a\n",
  "<abbr>",
  "</a>",
  "</A>",
  ' role="navigation"',
  ' role="banner"',
  ' ROLE="Search"',
  ' role="x"',
  ' role="contentinfo"',
  ' class="',
  ' class="menu"',
  ' class="content"',
  ' class="cookie-banner"',
  ' class="a>b"',
  ' CLASS="Policy"',
  ' id="policy"',
  ' id="x"',
  ' id="legal',
  " cookie",
  ' href="',
  ' href="/privacy"',
  ' href="x?y"',
  ' href="x#y"',
  ' href="?x"',
  ' href=""',
  "http-equiv=refresh",
  'http-equiv="refresh"',
  "http-equiv = 'REFRESH'",
  'content="0;url=',
  "content='5; URL=",
  'content="0;url=https://a.test/p"',
  "content=\"0;url='x'",
  "url=",
  "privacy policy",
  "Privacy Notice",
  "privacy\nstatement",
  "privacyx",
  "read",
  "View the ",
  "see",
  "open",
  "full",
  "complete ",
  "detailed",
  "Read the full Privacy Policy",
  "<!--",
  "-->",
  "&amp;",
  "window.location = 'https://b.test/'",
  'location.replace("https://c.test/")',
];

function corpus(seed: number, count: number, maxTokens: number): string[] {
  const random = prng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const length = 1 + Math.floor(random() * maxTokens);
    let s = "";
    for (let j = 0; j < length; j += 1) {
      s += TOKENS[Math.floor(random() * TOKENS.length)];
    }
    out.push(s);
  }
  return out;
}

const HTML_CORPUS = corpus(20261006, 6000, 24);

function checkAll<T>(
  label: string,
  reference: (html: string) => T,
  scanner: (html: string) => T
): void {
  for (const html of HTML_CORPUS) {
    assert.deepEqual(
      scanner(html),
      reference(html),
      `${label} diverged on ${JSON.stringify(html)}`
    );
  }
}

// ── Exactness against the regexes ───────────────────────────────────────

test("tag-block scanners match their regexes on the fuzz corpus", () => {
  for (const name of ["script", "style", "nav", "header", "div", "title"]) {
    checkAll(
      `stripTagBlocks(${name})`,
      (html) => refStripTagBlocks(html, name),
      (html) => stripTagBlocks(html, name)
    );
    checkAll(
      `firstTagBlockInner(${name})`,
      (html) => refFirstTagBlockInner(html, name),
      (html) => firstTagBlockInner(html, name)
    );
  }
  checkAll("scriptBlocks", refScriptBlocks, scriptBlocks);
});

test("the role scanner matches its regex on the fuzz corpus", () => {
  checkAll("stripRoleBlocks", refStripRoleBlocks, stripRoleBlocks);
});

test("block-to-text passes match their regexes on the fuzz corpus", () => {
  checkAll("blockTagsToText", refBlockTagsToText, blockTagsToText);
});

test("the meta refresh scanner matches its regex on the fuzz corpus", () => {
  checkAll("metaRefreshUrl", refMetaRefreshUrl, metaRefreshUrl);
});

test("the privacy-link scanner matches its regex on the fuzz corpus", () => {
  checkAll(
    "privacyPolicyLinkHref",
    refPrivacyPolicyLinkHref,
    privacyPolicyLinkHref
  );
  // Realistic anchors, each decomposition of the text pattern.
  for (const [html, expected] of [
    ['<a href="/p">Privacy Policy</a>', "/p"],
    [
      '<a class="x" href="/p?lang=en">read our full privacy notice</a>',
      "/p?lang=en",
    ],
    ['<a href="/p">View the complete Privacy Statement here</a>', "/p"],
    ['<a href="/p">  detailed\nprivacy policy</a>', "/p"],
    ['<a href="/p#top">Privacy Policy</a>', null],
    ['<a href="?q">Privacy Policy</a>', null],
    ['<a href="/p">Privacy</a>', null],
    ['<a href="/p">Our <b>Privacy Policy</b></a>', null],
    ['<a href="/a">Terms</a> <a href="/b">Privacy Policy</a>', "/b"],
    ['<ahref="/p">Privacy Policy</a>', null],
  ] as [string, string | null][]) {
    assert.equal(privacyPolicyLinkHref(html), expected, html);
    assert.equal(refPrivacyPolicyLinkHref(html), expected, html);
  }
});

test("the chunk slicer matches the regex scan on the fuzz corpus", () => {
  const random = prng(7);
  const alphabet = ["a", "b", " ", "  ", "\n", " ", " ", "xyz"];
  for (let i = 0; i < 4000; i += 1) {
    const length = Math.floor(random() * 40);
    let paragraph = "";
    for (let j = 0; j < length; j += 1) {
      paragraph += alphabet[Math.floor(random() * alphabet.length)];
    }
    const n = 1 + Math.floor(random() * 9);
    assert.deepEqual(
      sliceParagraph(paragraph, n),
      refSliceParagraph(paragraph, n),
      `sliceParagraph(${JSON.stringify(paragraph)}, ${n})`
    );
  }
  // The Rust core's pinned case: the scan never matches the head of an
  // unbroken run longer than a slice.
  assert.deepEqual(
    sliceParagraph(`${"a".repeat(10)} ${"x".repeat(25)} tail`, 20),
    [`${"a".repeat(10)} `, `${"x".repeat(20)} `, "tail"]
  );
});

test("chunkPolicyText keeps its shape: packed paragraphs, sliced long ones, whole fallback", () => {
  const short = ["one two", "three four", "five"].join("\n\n");
  assert.deepEqual(chunkPolicyText(short, 20), [
    "one two\n\nthree four",
    "five",
  ]);
  assert.deepEqual(chunkPolicyText(short, 12), [
    "one two",
    "three four",
    "five",
  ]);
  const long = `${"word ".repeat(600)}\n\nshort tail`;
  const chunks = chunkPolicyText(long, 2000);
  assert.ok(chunks.length >= 3, `expected slices, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2000);
    assert.equal(chunk, chunk.trim());
  }
  assert.equal(chunks.at(-1), "short tail");
  assert.deepEqual(chunkPolicyText("", 1000), [""]);
});

// ── The two container scanners follow the Rust core ─────────────────────

test("the class-container scanner follows the Rust scanner on the fuzz corpus", () => {
  checkAll("stripClassContainers", rustStripClassContainers, (html) =>
    stripClassContainers(html, (classes) => CHROME_CLASS_PATTERN.test(classes))
  );
  // The Rust core's own pinned cases.
  assert.equal(
    stripClassContainers(
      '<div class="sidebar-wrap"><div class="content">INNER</div>OUTER TAIL</div>',
      (classes) => CHROME_CLASS_PATTERN.test(classes)
    ),
    " OUTER TAIL</div>"
  );
  assert.equal(
    stripClassContainers('<div class="menu"><span>Unclosed', () => true),
    '<div class="menu"><span>Unclosed'
  );
  assert.equal(
    stripClassContainers(
      '<ul class="nav-main"><li>a</li></ul data-x="1">tail',
      () => true
    ),
    " tail"
  );
});

test("the policy-container scanner follows the Rust scanner on the fuzz corpus", () => {
  checkAll("policyContainers", rustPolicyContainers, (html) =>
    policyContainers(html).map((c) => [c.attr, c.inner])
  );
});

test("both container scanners agree with Node's regexes on well-formed markup", () => {
  // The scanners differ from a backtracking engine only when an opener has
  // no closer and an earlier `class`/`id` occurrence would have given a
  // shorter opener; on markup whose containers close they agree.
  const pages = [
    '<div class="menu"><p>x</p></div><div class="content"><p>Policy</p></div>',
    '<section class="cookie-consent">eat</section><main><div id="policy-body">text</div></main>',
    '<div class="a" class="menu">one</div><div class="b">two</div>',
    '<div class="x"><div class="footer">inner</div>outer</div>',
    '<DIV CLASS="Social-share">s</DIV><div id="document" class="legal">d</div>',
  ];
  for (const html of pages) {
    assert.equal(
      stripClassContainers(html, (classes) =>
        CHROME_CLASS_PATTERN.test(classes)
      ),
      regexStripClassContainers(html),
      html
    );
    assert.deepEqual(
      policyContainers(html).map((c) => [c.attr, c.inner]),
      regexPolicyContainers(html),
      html
    );
  }
});

// ── Composition ─────────────────────────────────────────────────────────

test("extractPolicyTextFromHtml reads a page as before", () => {
  const body = "We collect personal information. ".repeat(80);
  const html = [
    "<html><head><title>Acme &amp; Co · Privacy</title></head><body>",
    '<nav class="navbar"><a href="/">Home</a></nav>',
    '<div role="banner">Cookie wall</div>',
    "<main><h1>Privacy Policy</h1><p>",
    body,
    "</p><script>window.x = 1</script></main>",
    '<footer class="site-footer">© Acme</footer></body></html>',
  ].join("");
  const { title, text } = extractPolicyTextFromHtml(html, "fallback");
  assert.equal(title, "Acme & Co · Privacy");
  assert.ok(
    text.startsWith("Privacy Policy\n\nWe collect personal information.")
  );
  assert.ok(!text.includes("Home"));
  assert.ok(!text.includes("Cookie wall"));
  assert.ok(!text.includes("window.x"));
  assert.ok(!text.includes("Acme"));

  // No main/article/body, and the policy sits in a container whose class
  // reads as chrome: the first pass strips it and comes up short, so the
  // second pass finds the container again by its `id` and keeps it.
  const loose = [
    '<div class="menu-wrapper" id="policy-body">',
    body,
    "</div><p>Contact us</p>",
  ].join("");
  const second = extractPolicyTextFromHtml(loose, "fallback");
  assert.equal(second.title, "fallback");
  assert.ok(
    second.text.startsWith("We collect personal information."),
    second.text.slice(0, 80)
  );
  assert.ok(!second.text.includes("Contact us"));
});

// ── Time stays linear on the shapes that used to stall ──────────────────

const BUDGET_MS = 2000;

function timed(label: string, run: () => unknown): void {
  const started = performance.now();
  run();
  const elapsed = performance.now() - started;
  assert.ok(
    elapsed < BUDGET_MS,
    `${label} took ${Math.round(elapsed)} ms (budget ${BUDGET_MS} ms)`
  );
}

test("tag-block, role and block-to-text scans stay fast on a megabyte of unclosed openers", () => {
  const unclosedScripts = `<html><body>${"<script>".repeat(125_000)}`;
  timed("stripTagBlocks(script)", () =>
    stripTagBlocks(unclosedScripts, "script")
  );
  timed("findTagBlocks(title)", () =>
    findTagBlocks("<title>".repeat(140_000), "title")
  );
  timed("firstTagBlockInner(main)", () =>
    firstTagBlockInner("<main>".repeat(160_000), "main")
  );
  timed("stripRoleBlocks", () => stripRoleBlocks(`${"<a ".repeat(330_000)}>`));
  timed("blockTagsToText(<)", () => blockTagsToText("<".repeat(1_000_000)));
  timed("blockTagsToText(<p )", () => blockTagsToText("<p ".repeat(330_000)));
  timed("blockTagsToText(<script no >)", () =>
    blockTagsToText("<script ".repeat(125_000))
  );
});

test("container, meta and link scans stay fast on a megabyte of unclosed openers", () => {
  const isChrome = (classes: string) => CHROME_CLASS_PATTERN.test(classes);
  timed("stripClassContainers", () =>
    stripClassContainers('<div class="x">'.repeat(66_000), isChrome)
  );
  timed("stripClassContainers(no >)", () =>
    stripClassContainers("<div ".repeat(200_000), isChrome)
  );
  timed("policyContainers", () =>
    policyContainers('<div class="policy">'.repeat(50_000))
  );
  timed("metaRefreshUrl", () => metaRefreshUrl("<meta ".repeat(166_000)));
  timed("metaRefreshUrl(one run)", () =>
    metaRefreshUrl(`<meta ${"http-equiv=refresh ".repeat(50_000)}`)
  );
  timed("privacyPolicyLinkHref", () =>
    privacyPolicyLinkHref('<a href="x">'.repeat(83_000))
  );
  timed("privacyPolicyLinkHref(one run)", () =>
    privacyPolicyLinkHref(`<a ${'href="x" '.repeat(100_000)}`)
  );
  timed("privacyPolicyLinkHref(spaces)", () =>
    privacyPolicyLinkHref(`<a href="x">read${" ".repeat(1_000_000)}</a>`)
  );
});

test("the chunk slicer stays fast on a megabyte with no whitespace", () => {
  timed("sliceParagraph(3000)", () =>
    sliceParagraph("x".repeat(1_000_000), 3000)
  );
  timed("sliceParagraph(11000)", () =>
    sliceParagraph("x".repeat(1_000_000), 11_000)
  );
  timed("chunkPolicyText", () =>
    chunkPolicyText(`intro\n\n${"x".repeat(1_000_000)}`, 4000)
  );
});
