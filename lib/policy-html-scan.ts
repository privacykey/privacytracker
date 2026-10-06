/**
 * Linear-time scanners for the HTML and text patterns that
 * `lib/privacy-policy.ts` once ran as regular expressions over a whole
 * fetched policy page.
 *
 * Why not the regexes: V8 backtracks. A `<tag\b[^>]*>[\s\S]*?</tag …>` block
 * pattern rescans to the end of the document for every opener that has no
 * closer, a `<[^>]+>` tag pattern rescans to the next `>` for every `<`
 * before it, and the chunk slicer's `[\s\S]{1,n}(?:\s|$)` tries every length
 * at every position of a run with no whitespace. The page comes from
 * whatever host the developer named on the App Store, so a page built to
 * those shapes held the event loop for seconds per megabyte, during the
 * automatic fetch that follows every import and sync (fingerprints
 * `privacy-policy/html-text-extraction/lazy-regex-quadratic-scan` and
 * `privacy-policy/chunk-paragraph-regex/greedy-quantifier-backtracking`).
 *
 * What these keep: the result. Each scanner returns exactly what the regex
 * it replaces returned, for every input, except the two container scanners
 * (`stripClassContainers`, `policyContainers`), which follow the Rust
 * core's scanners for the same two patterns (the `regex` crate has no
 * backreferences): the opening tag is matched as the regex matches it
 * alone, the first closing tag of the same name is taken from the end of
 * that opener, and a miss moves the scan on one character. On every page
 * the oracles record, both agree with the regexes.
 * `tests/app/policy-html-scan.test.ts` checks both claims by differential
 * fuzzing against the original regexes and against a plain port of the
 * Rust loops, and times the shapes that used to stall.
 *
 * How they stay linear: a search that fails from one position cannot
 * succeed from a later one, so it is never repeated. The next `>` (or `"`,
 * `<`) is remembered between queries, a closing tag found absent after a
 * position is absent for every later opener of that name, and the
 * attribute occurrences inside one `>`-free run are listed once for every
 * opener in that run.
 *
 * Case: JavaScript's `i` flag without `u` folds only ASCII letters against
 * these ASCII patterns, so every comparison here is an ASCII fold.
 */

// JavaScript's `\s` without the `u` flag, as a code-unit set.
const JS_SPACE_CODES = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
  0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

/** Whether a UTF-16 code unit is matched by JavaScript's `\s`. */
export function isJsSpace(code: number): boolean {
  return JS_SPACE_CODES.has(code);
}

/** Whether a code unit is matched by JavaScript's `\w` (so bounds `\b`). */
function isWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/** `html.startsWith(literal, at)` under an ASCII case fold; `literal` is lower case. */
function startsWithFold(html: string, at: number, literal: string): boolean {
  if (at < 0 || at + literal.length > html.length) {
    return false;
  }
  for (let i = 0; i < literal.length; i += 1) {
    let code = html.charCodeAt(at + i);
    if (code >= 65 && code <= 90) {
      code += 32;
    }
    if (code !== literal.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function skipSpaces(html: string, from: number, end: number): number {
  let at = from;
  while (at < end && isJsSpace(html.charCodeAt(at))) {
    at += 1;
  }
  return at;
}

/**
 * The next occurrence of an ASCII literal at or after `from`, ignoring
 * ASCII case, as a `gi` regex of the literal finds it. A literal has no
 * quantifier, so the search is linear in the distance scanned.
 */
class LiteralFinder {
  private readonly re: RegExp;

  constructor(literal: string) {
    this.re = new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  }

  next(html: string, from: number): number {
    if (from < 0 || from > html.length) {
      return -1;
    }
    this.re.lastIndex = from;
    const match = this.re.exec(html);
    return match ? match.index : -1;
  }
}

const finders = new Map<string, LiteralFinder>();
function finder(literal: string): LiteralFinder {
  let found = finders.get(literal);
  if (!found) {
    found = new LiteralFinder(literal);
    finders.set(literal, found);
  }
  return found;
}

/**
 * The next occurrence of one character at or after `from`, remembering the
 * run it has already found empty: after a query, no `ch` lies in
 * `[lo, at)`, and `at` is the first `ch` at or after `lo` (or the length
 * when there is none). A later query inside that run is answered at once;
 * one before it scans only the gap it adds.
 */
class CharIndex {
  private readonly html: string;
  private readonly ch: string;
  private readonly len: number;
  private lo = 0;
  private at: number;

  constructor(html: string, ch: string) {
    this.html = html;
    this.ch = ch;
    this.len = html.length;
    const first = html.indexOf(ch);
    this.at = first < 0 ? this.len : first;
  }

  next(from: number): number {
    const start = Math.max(0, from);
    if (start > this.at) {
      const found = this.html.indexOf(this.ch, start);
      this.lo = start;
      this.at = found < 0 ? this.len : found;
    } else if (start < this.lo) {
      const gap = this.html.slice(start, this.lo).indexOf(this.ch);
      this.lo = start;
      if (gap >= 0) {
        this.at = start + gap;
      }
    }
    return this.at === this.len ? -1 : this.at;
  }
}

// ── Tag blocks: `<name\b[^>]*>[\s\S]*?</name\b[^>]*>` ───────────────────

/** One match of a tag-block pattern: `[start, end)`, with the opener's and closer's bounds. */
export interface TagBlock {
  closeStart: number;
  end: number;
  openEnd: number;
  start: number;
}

/**
 * The first `</name\b[^>]*>` at or after `from`, or null when none can
 * complete anywhere after it (no further `</name\b`, or no `>` after one).
 */
function findCloser(
  html: string,
  name: string,
  from: number,
  gt: CharIndex
): { closeStart: number; end: number } | null {
  const close = finder(`</${name}`);
  let at = from;
  for (;;) {
    const closeStart = close.next(html, at);
    if (closeStart < 0) {
      return null;
    }
    const afterName = closeStart + 2 + name.length;
    if (isWordCode(html.charCodeAt(afterName))) {
      at = closeStart + 1;
      continue;
    }
    const closeGt = gt.next(afterName);
    if (closeGt < 0) {
      return null;
    }
    return { closeStart, end: closeGt + 1 };
  }
}

/**
 * Every match of `/<name\b[^>]*>[\s\S]*?<\/name\b[^>]*>/gi`, in order, up
 * to `limit` of them. An opener with no completing closer after it fails,
 * and so does every later opener, since a closer after a later opener would
 * also follow this one.
 */
export function findTagBlocks(
  html: string,
  name: string,
  limit = Number.POSITIVE_INFINITY
): TagBlock[] {
  const open = finder(`<${name}`);
  const gt = new CharIndex(html, ">");
  const blocks: TagBlock[] = [];
  let pos = 0;
  while (blocks.length < limit) {
    const start = open.next(html, pos);
    if (start < 0) {
      break;
    }
    const afterName = start + 1 + name.length;
    if (isWordCode(html.charCodeAt(afterName))) {
      pos = start + 1;
      continue;
    }
    const openGt = gt.next(afterName);
    if (openGt < 0) {
      break;
    }
    const closer = findCloser(html, name, openGt + 1, gt);
    if (!closer) {
      break;
    }
    blocks.push({
      start,
      openEnd: openGt + 1,
      closeStart: closer.closeStart,
      end: closer.end,
    });
    pos = closer.end;
  }
  return blocks;
}

function replaceSpans(
  html: string,
  spans: Array<{ start: number; end: number }>,
  replacement: string
): string {
  if (spans.length === 0) {
    return html;
  }
  const out: string[] = [];
  let copied = 0;
  for (const span of spans) {
    out.push(html.slice(copied, span.start), replacement);
    copied = span.end;
  }
  out.push(html.slice(copied));
  return out.join("");
}

/** `html.replace(/<name\b[^>]*>[\s\S]*?<\/name\b[^>]*>/gi, " ")`. */
export function stripTagBlocks(html: string, name: string): string {
  return replaceSpans(html, findTagBlocks(html, name), " ");
}

/** `html.match(/<name\b[^>]*>([\s\S]*?)<\/name\b[^>]*>/i)?.[1]`, or null. */
export function firstTagBlockInner(html: string, name: string): string | null {
  const [block] = findTagBlocks(html, name, 1);
  return block ? html.slice(block.openEnd, block.closeStart) : null;
}

/** Every `<script\b[^>]*>[\s\S]*?</script\b[^>]*>` block, whole, in order. */
export function scriptBlocks(html: string): string[] {
  return findTagBlocks(html, "script").map((block) =>
    html.slice(block.start, block.end)
  );
}

// ── Landmark roles ──────────────────────────────────────────────────────

const ROLE_ATTR =
  /\srole="(?:navigation|banner|contentinfo|complementary|search)"/gi;

/**
 * `html.replace(/<[^>]+\srole="(navigation|banner|contentinfo|complementary|search)"[^>]*>[\s\S]*?<\/[^>]+\s*>/gi, " ")`.
 *
 * The opener is any `<…>` whose text, after at least one character, holds
 * a landmark `role`; the closer is the first `</` followed by at least one
 * character and a `>`. The role occurrences of one `>`-free run are listed
 * once for every `<` in it.
 */
export function stripRoleBlocks(html: string): string {
  const gt = new CharIndex(html, ">");
  const spans: Array<{ start: number; end: number }> = [];
  let pos = 0;
  let segmentEnd = -1;
  let roles: number[] = [];
  let rolePointer = 0;
  for (;;) {
    const start = html.indexOf("<", pos);
    if (start < 0) {
      break;
    }
    const openGt = gt.next(start + 1);
    if (openGt < 0) {
      break;
    }
    if (start > segmentEnd) {
      segmentEnd = openGt;
      roles = [];
      rolePointer = 0;
      const run = html.slice(start + 1, openGt);
      ROLE_ATTR.lastIndex = 0;
      let match = ROLE_ATTR.exec(run);
      while (match !== null) {
        roles.push(start + 1 + match.index);
        ROLE_ATTR.lastIndex = match.index + 1;
        match = ROLE_ATTR.exec(run);
      }
    }
    // `[^>]+` wants a character between `<` and the `\s` of `\srole`.
    while (rolePointer < roles.length && roles[rolePointer] < start + 2) {
      rolePointer += 1;
    }
    if (rolePointer >= roles.length) {
      pos = start + 1;
      continue;
    }
    let from = openGt + 1;
    let end = -1;
    for (;;) {
      const closeStart = html.indexOf("</", from);
      if (closeStart < 0) {
        break;
      }
      const closeGt = gt.next(closeStart + 2);
      if (closeGt < 0) {
        break;
      }
      if (closeGt === closeStart + 2) {
        // `</>` has nothing for `[^>]+`.
        from = closeStart + 1;
        continue;
      }
      end = closeGt + 1;
      break;
    }
    if (end < 0) {
      // No closer can complete after this opener, nor after any later one.
      break;
    }
    spans.push({ start, end });
    pos = end;
  }
  return replaceSpans(html, spans, " ");
}

// ── Attribute-bearing containers (the Rust core's scanners) ─────────────

/**
 * One `\sATTR="` inside a `>`-free run: where its value starts, where the
 * value's closing quote is (-1 when there is none), and where the first
 * `>` after that quote is (-1 when there is none). Computed once per run
 * and shared by every opener candidate in it.
 */
interface AttrOccurrence {
  at: number;
  gt: number;
  quote: number;
  valueStart: number;
}

function listAttrOccurrences(
  html: string,
  attr: RegExp,
  from: number,
  end: number,
  quote: CharIndex,
  gt: CharIndex
): AttrOccurrence[] {
  const occurrences: AttrOccurrence[] = [];
  const run = html.slice(from, end);
  attr.lastIndex = 0;
  let match = attr.exec(run);
  while (match !== null) {
    const at = from + match.index;
    const valueStart = at + match[0].length;
    const closing = quote.next(valueStart);
    occurrences.push({
      at,
      valueStart,
      quote: closing,
      gt: closing < 0 ? -1 : gt.next(closing + 1),
    });
    attr.lastIndex = match.index + 1;
    match = attr.exec(run);
  }
  return occurrences;
}

/**
 * The opener a backtracking engine settles on for a candidate whose
 * `[^>]*\sATTR="…"[^>]*>` runs over `occurrences` (all at or after
 * `afterName`): greedy `[^>]*` tries the last occurrence first, so the
 * last one whose value closes, whose tag then closes, and which `accept`s
 * decides where the opener ends.
 */
function chooseOpener(
  occurrences: AttrOccurrence[],
  afterName: number,
  accept: (occurrence: AttrOccurrence) => boolean
): AttrOccurrence | null {
  for (let index = occurrences.length - 1; index >= 0; index -= 1) {
    const occurrence = occurrences[index];
    if (occurrence.at < afterName) {
      break;
    }
    if (occurrence.quote >= 0 && occurrence.gt >= 0 && accept(occurrence)) {
      return occurrence;
    }
  }
  return null;
}

/**
 * Per tag name, the lowest position from which a closer search found
 * nothing: a search from there or later finds nothing either.
 */
class CloserMemo {
  private readonly noneFrom = new Map<string, number>();

  known(name: string, from: number): boolean {
    const none = this.noneFrom.get(name);
    return none !== undefined && from >= none;
  }

  miss(name: string, from: number): void {
    const none = this.noneFrom.get(name);
    if (none === undefined || from < none) {
      this.noneFrom.set(name, from);
    }
  }
}

/**
 * A scan over the openers `<(names)\b…` of one pattern. Candidates come in
 * document order; the attribute occurrences of the `>`-free run a
 * candidate starts in are listed once and reused by the candidates after
 * it in the same run.
 */
class ContainerScan {
  private readonly html: string;
  private readonly open: RegExp;
  private readonly attr: RegExp;
  private readonly gt: CharIndex;
  private readonly quote: CharIndex;
  private segmentEnd = -1;
  private occurrences: AttrOccurrence[] = [];

  constructor(html: string, open: RegExp, attr: RegExp) {
    this.html = html;
    this.open = open;
    this.attr = attr;
    this.gt = new CharIndex(html, ">");
    this.quote = new CharIndex(html, '"');
  }

  /** The next candidate at or after `from`: its start and lower-cased name. */
  nextCandidate(from: number): { start: number; name: string } | null {
    if (from > this.html.length) {
      return null;
    }
    this.open.lastIndex = from;
    const match = this.open.exec(this.html);
    return match ? { start: match.index, name: match[1].toLowerCase() } : null;
  }

  /**
   * The attribute occurrences this candidate's `[^>]*` can reach, or null
   * when no `>` follows the name (no opener completes from here on).
   */
  reachable(afterName: number): AttrOccurrence[] | null {
    const openGt = this.gt.next(afterName);
    if (openGt < 0) {
      return null;
    }
    if (afterName > this.segmentEnd) {
      this.segmentEnd = openGt;
      this.occurrences = listAttrOccurrences(
        this.html,
        this.attr,
        afterName,
        openGt,
        this.quote,
        this.gt
      );
    }
    return this.occurrences;
  }

  gtIndex(): CharIndex {
    return this.gt;
  }
}

const CHROME_CONTAINER_OPEN = /<(div|section|aside|header|footer|ul|ol)\b/gi;
const CLASS_ATTR = /\sclass="/gi;
const FIRST_CLASS_ATTR = /\sclass="([^"]*)"/i;

/**
 * Node's
 * `html.replace(/<(div|section|aside|header|footer|ul|ol)\b[^>]*\sclass="[^"]*"[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi, cb)`
 * where `cb` replaces a match whose first `class` attribute `isChrome`
 * with a space and keeps any other, as the Rust core's
 * `strip_class_containers` scans it: the opener matched on its own, the
 * first `</name\b[^>]*>` from its end, and on a miss the scan resumes one
 * character after the `<`.
 */
export function stripClassContainers(
  html: string,
  isChrome: (classes: string) => boolean
): string {
  const scan = new ContainerScan(html, CHROME_CONTAINER_OPEN, CLASS_ATTR);
  const closers = new CloserMemo();
  const spans: Array<{ start: number; end: number }> = [];
  let searchFrom = 0;
  for (;;) {
    const candidate = scan.nextCandidate(searchFrom);
    if (!candidate) {
      break;
    }
    const { start, name } = candidate;
    const afterName = start + 1 + name.length;
    const occurrences = scan.reachable(afterName);
    if (!occurrences) {
      break;
    }
    const opener = chooseOpener(occurrences, afterName, () => true);
    if (!opener) {
      searchFrom = start + 1;
      continue;
    }
    const openEnd = opener.gt + 1;
    const closer = closers.known(name, openEnd)
      ? null
      : findCloser(html, name, openEnd, scan.gtIndex());
    if (!closer) {
      closers.miss(name, openEnd);
      searchFrom = start + 1;
      continue;
    }
    const full = html.slice(start, closer.end);
    const classes = full.match(FIRST_CLASS_ATTR);
    if (classes && isChrome(classes[1])) {
      spans.push({ start, end: closer.end });
    }
    searchFrom = closer.end;
  }
  return replaceSpans(html, spans, " ");
}

const POLICY_CONTAINER_OPEN = /<(div|section|article|main)\b/gi;
const ID_OR_CLASS_ATTR = /\s(?:id|class)="/gi;
const POLICY_KEYWORD = /policy|privacy|legal|terms|content|main|body|document/i;

/** One policy-looking container of the second extraction pass. */
export interface PolicyContainer {
  /** The `id` or `class` value the opener was matched on. */
  attr: string;
  /** The markup between the opener and its closing tag. */
  inner: string;
}

/**
 * Node's `exec` loop over
 * `/<(div|section|article|main)\b[^>]*\s(?:id|class)="([^"]*(?:policy|privacy|legal|terms|content|main|body|document)[^"]*)"[^>]*>([\s\S]*?)<\/\1>/gi`,
 * as the Rust core's `extract_policy_text_from_html` scans it: the opener
 * matched on its own, the first literal `</name>` from its end, and on a
 * miss the scan resumes one character after the `<`. Returns every match's
 * attribute value and inner markup, in order.
 */
export function policyContainers(html: string): PolicyContainer[] {
  const scan = new ContainerScan(html, POLICY_CONTAINER_OPEN, ID_OR_CLASS_ATTR);
  const closers = new CloserMemo();
  const out: PolicyContainer[] = [];
  let searchFrom = 0;
  for (;;) {
    const candidate = scan.nextCandidate(searchFrom);
    if (!candidate) {
      break;
    }
    const { start, name } = candidate;
    const afterName = start + 1 + name.length;
    const occurrences = scan.reachable(afterName);
    if (!occurrences) {
      break;
    }
    const opener = chooseOpener(occurrences, afterName, (occurrence) =>
      POLICY_KEYWORD.test(html.slice(occurrence.valueStart, occurrence.quote))
    );
    if (!opener) {
      searchFrom = start + 1;
      continue;
    }
    const openEnd = opener.gt + 1;
    const closeTag = `</${name}>`;
    const closeStart = closers.known(name, openEnd)
      ? -1
      : finder(closeTag).next(html, openEnd);
    if (closeStart < 0) {
      closers.miss(name, openEnd);
      searchFrom = start + 1;
      continue;
    }
    out.push({
      attr: html.slice(opener.valueStart, opener.quote),
      inner: html.slice(openEnd, closeStart),
    });
    searchFrom = closeStart + closeTag.length;
  }
  return out;
}

// ── Block structure to text ─────────────────────────────────────────────

const LINE_BREAK = /<br\s*\/?>/gi;
const BLOCK_CLOSE =
  /<\/(p|div|li|section|article|main|header|h[1-6]|tr|td|blockquote|ul|ol)>/gi;
const BLOCK_OPEN_NAME =
  /<(?:p|div|li|section|article|main|header|h[1-6]|tr|td|blockquote|ul|ol)/gi;

/** `html.replace(/<(p|div|…|ol)[^>]*>/gi, "\n")`: a block start tag, to its first `>`. */
function blockOpenersToNewlines(html: string): string {
  const gt = new CharIndex(html, ">");
  const spans: Array<{ start: number; end: number }> = [];
  let pos = 0;
  for (;;) {
    if (pos > html.length) {
      break;
    }
    BLOCK_OPEN_NAME.lastIndex = pos;
    const match = BLOCK_OPEN_NAME.exec(html);
    if (!match) {
      break;
    }
    const openGt = gt.next(match.index + match[0].length);
    if (openGt < 0) {
      break;
    }
    spans.push({ start: match.index, end: openGt + 1 });
    pos = openGt + 1;
  }
  return replaceSpans(html, spans, "\n");
}

/** `html.replace(/<[^>]+>/g, " ")`: any `<`, at least one character, and the next `>`. */
function tagsToSpaces(html: string): string {
  const gt = new CharIndex(html, ">");
  const spans: Array<{ start: number; end: number }> = [];
  let pos = 0;
  for (;;) {
    const start = html.indexOf("<", pos);
    if (start < 0) {
      break;
    }
    const closeGt = gt.next(start + 1);
    if (closeGt < 0) {
      break;
    }
    if (closeGt === start + 1) {
      pos = start + 1;
      continue;
    }
    spans.push({ start, end: closeGt + 1 });
    pos = closeGt + 1;
  }
  return replaceSpans(html, spans, " ");
}

/**
 * The four passes of `htmlBlockToText` before entity decoding: `<br>` and
 * block boundaries to newlines, every other tag to a space. The `<br\s*\/?>`
 * and `</block>` passes keep their regexes, which have no quantifier a
 * page can make backtrack across the document.
 */
export function blockTagsToText(html: string): string {
  const withBreaks = html.replace(LINE_BREAK, "\n");
  const closed = withBreaks.replace(BLOCK_CLOSE, "\n");
  return tagsToSpaces(blockOpenersToNewlines(closed));
}

// ── Meta refresh ────────────────────────────────────────────────────────

const HTTP_EQUIV_REFRESH = /http-equiv\s*=\s*["']?refresh["']?/gi;
const REFRESH_CONTENT =
  /content\s*=\s*["']\s*\d+\s*;\s*url\s*=\s*["']?([^"'>\s]+)/gi;

/**
 * Group 1 of
 * `html.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']\s*\d+\s*;\s*url\s*=\s*(?:["']?)([^"'>\s]+)(?:["']?)/i)`,
 * or null.
 *
 * The whole match lies in the `>`-free run that starts at a `<meta`. Greedy
 * `[^>]+` and `[^>]*` make a backtracking engine settle on the last
 * `content` occurrence that some earlier `http-equiv` occurrence can
 * reach, which is the last one after the first `http-equiv`.
 */
export function metaRefreshUrl(html: string): string | null {
  const meta = finder("<meta");
  const gt = new CharIndex(html, ">");
  let pos = 0;
  for (;;) {
    const start = meta.next(html, pos);
    if (start < 0) {
      return null;
    }
    const runEnd = gt.next(start + 5);
    const run = html.slice(start, runEnd < 0 ? html.length : runEnd);

    // `[^>]+` wants a character between `<meta` and `http-equiv`.
    let equivEnd = -1;
    HTTP_EQUIV_REFRESH.lastIndex = 0;
    let match = HTTP_EQUIV_REFRESH.exec(run);
    while (match !== null) {
      if (match.index >= 6) {
        equivEnd = match.index + match[0].length;
        break;
      }
      HTTP_EQUIV_REFRESH.lastIndex = match.index + 1;
      match = HTTP_EQUIV_REFRESH.exec(run);
    }
    if (equivEnd >= 0) {
      let url: string | null = null;
      REFRESH_CONTENT.lastIndex = 0;
      match = REFRESH_CONTENT.exec(run);
      while (match !== null) {
        if (match.index >= equivEnd) {
          url = match[1];
        }
        REFRESH_CONTENT.lastIndex = match.index + 1;
        match = REFRESH_CONTENT.exec(run);
      }
      if (url !== null) {
        return url;
      }
    }
    // No `<meta` in this run can do better: each sees fewer occurrences.
    if (runEnd < 0) {
      return null;
    }
    pos = runEnd + 1;
  }
}

// ── The "Privacy Policy" link ───────────────────────────────────────────

const HREF_ATTR = /href="/gi;
const PRIVACY_PHRASE = /privacy\s*(?:policy|notice|statement)/gi;
const LEAD_WORDS = ["read", "view", "see", "open"];
const QUALIFIER_WORDS = ["full", "complete", "detailed"];

/** Where every `privacy\s*(policy|notice|statement)` starts, in order. */
function phraseStarts(html: string): number[] {
  const starts: number[] = [];
  PRIVACY_PHRASE.lastIndex = 0;
  let match = PRIVACY_PHRASE.exec(html);
  while (match !== null) {
    starts.push(match.index);
    PRIVACY_PHRASE.lastIndex = match.index + 1;
    match = PRIVACY_PHRASE.exec(html);
  }
  return starts;
}

/** The first index in sorted `values` not below `target`. */
function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Whether `html[textStart, textEnd)`, the anchor text up to its `</a>`,
 * matches
 * `^\s*(?:(?:read|view|see|open)[^<]*)?(?:full|complete|detailed)?\s*privacy\s*(?:policy|notice|statement)[^<]*$`.
 *
 * With a lead word, `[^<]*` can run to any later phrase; without one the
 * phrase follows the optional qualifier and whitespace directly.
 */
function anchorTextMatches(
  html: string,
  phrases: number[],
  textStart: number,
  textEnd: number
): boolean {
  const start = skipSpaces(html, textStart, textEnd);
  for (const word of LEAD_WORDS) {
    if (startsWithFold(html, start, word)) {
      const from = lowerBound(phrases, start + word.length);
      return from < phrases.length && phrases[from] < textEnd;
    }
  }
  let afterQualifier = start;
  for (const word of QUALIFIER_WORDS) {
    if (startsWithFold(html, start, word)) {
      afterQualifier = start + word.length;
      break;
    }
  }
  const phraseAt = skipSpaces(html, afterQualifier, textEnd);
  const index = lowerBound(phrases, phraseAt);
  return index < phrases.length && phrases[index] === phraseAt;
}

/**
 * Group 1 of
 * `html.match(/<a\s+[^>]*href="([^"#?]+(?:\?[^"#]*)?)"[^>]*>\s*(?:(?:read|view|see|open)[^<]*)?(?:full|complete|detailed)?\s*(?:privacy\s*(?:policy|notice|statement))[^<]*<\/a>/i)`,
 * or null.
 *
 * For each `<a` followed by whitespace, the `href="` occurrences of its
 * `>`-free run are tried from the last, as greedy `[^>]*` tries them: the
 * value runs to the next `"` and must not be empty, start with `?` or hold
 * a `#`; the opener ends at the first `>` after that quote; the text runs
 * to the first `<`, which must begin `</a>`. When every occurrence fails
 * for one `<a`, every later `<a` in the same run fails too.
 */
export function privacyPolicyLinkHref(html: string): string | null {
  const anchor = finder("<a");
  const gt = new CharIndex(html, ">");
  const quote = new CharIndex(html, '"');
  const lt = new CharIndex(html, "<");
  let phrases: number[] | null = null;
  let segmentEnd = -1;
  let occurrences: AttrOccurrence[] = [];
  let verdicts: Array<string | null | undefined> = [];
  let failedSegmentEnd = -1;
  let pos = 0;
  for (;;) {
    const start = anchor.next(html, pos);
    if (start < 0) {
      return null;
    }
    if (!isJsSpace(html.charCodeAt(start + 2))) {
      pos = start + 1;
      continue;
    }
    const afterSpaces = skipSpaces(html, start + 3, html.length);
    const openGt = gt.next(afterSpaces);
    if (openGt < 0) {
      // No opener can end without a `>`.
      return null;
    }
    if (afterSpaces <= failedSegmentEnd) {
      pos = start + 1;
      continue;
    }
    if (afterSpaces > segmentEnd) {
      segmentEnd = openGt;
      occurrences = listAttrOccurrences(
        html,
        HREF_ATTR,
        afterSpaces,
        openGt,
        quote,
        gt
      );
      verdicts = new Array(occurrences.length);
    }
    for (let index = occurrences.length - 1; index >= 0; index -= 1) {
      const occurrence = occurrences[index];
      if (occurrence.at < afterSpaces) {
        break;
      }
      let verdict = verdicts[index];
      if (verdict === undefined) {
        verdict = null;
        const { valueStart, quote: closing, gt: tagEnd } = occurrence;
        if (closing > valueStart && tagEnd >= 0) {
          const value = html.slice(valueStart, closing);
          if (!(value.startsWith("?") || value.includes("#"))) {
            const textEnd = lt.next(tagEnd + 1);
            if (textEnd >= 0 && startsWithFold(html, textEnd, "</a>")) {
              phrases ??= phraseStarts(html);
              if (anchorTextMatches(html, phrases, tagEnd + 1, textEnd)) {
                verdict = value;
              }
            }
          }
        }
        verdicts[index] = verdict;
      }
      if (verdict !== null) {
        return verdict;
      }
    }
    failedSegmentEnd = segmentEnd;
    pos = start + 1;
  }
}

// ── Chunk slicing ───────────────────────────────────────────────────────

/**
 * `paragraph.match(/[\s\S]{1,n}(?:\s|$)/g) ?? []`, as a backtracking
 * engine runs it, in one pass: from each position, the longest run of at
 * most `n` code units followed by whitespace (consumed) or by the end;
 * where none exists the scan moves on one unit, so the head of an unbroken
 * run longer than `n` is never matched. The Rust core's `regex_slices`
 * does the same.
 */
export function sliceParagraph(paragraph: string, n: number): string[] {
  const len = paragraph.length;
  const slices: string[] = [];
  let pos = 0;
  // The last whitespace at or before `scanned`.
  let scanned = -1;
  let lastSpace = -1;
  while (pos < len) {
    if (len - pos <= n) {
      slices.push(paragraph.slice(pos));
      break;
    }
    const limit = pos + n;
    while (scanned < limit) {
      scanned += 1;
      if (isJsSpace(paragraph.charCodeAt(scanned))) {
        lastSpace = scanned;
      }
    }
    if (lastSpace > pos) {
      slices.push(paragraph.slice(pos, lastSpace + 1));
      pos = lastSpace + 1;
    } else {
      pos += 1;
    }
  }
  return slices;
}
