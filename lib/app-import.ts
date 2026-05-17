const NOISE_LINES = [
  "iphone storage",
  "recommendations",
  "offload unused apps",
  "documents & data",
  "last used",
  "app size",
  "search",
  "cancel",
  "done",
  "edit",
  "settings",
  "general",
  "storage",
  "icloud",
  "back",
  "siri",
  "family",
];

/**
 * Hard cap on an individual app name. iTunes Search is happy up to ~200 chars,
 * but real app names are almost never over 50. We keep a generous bound so we
 * don't clip legitimate titles with developer tagline suffixes, but still
 * defend against absurd OCR garbage or paste-bomb inputs.
 */
const MAX_NAME_LENGTH = 120;

/**
 * Maximum rows we hand to downstream search. A single iPhone rarely has more
 * than ~400 user-installed apps; we cap generously at 500 so realistic
 * Configurator exports (200-300 rows is typical) fit without truncation.
 * /api/search and the OCR heuristic enforce the same ceiling defensively.
 */
export const MAX_IMPORT_ROWS = 500;

/**
 * Bundle-ID patterns that identify Safari home-screen web apps / web clips
 * rather than App Store apps. cfgutil reports these alongside real apps —
 * they share the same iPhone "installedApps" list as native installs — but
 * iTunes Lookup never knows about them (no App Store record exists), so
 * routing them through the bundle/name search path is wasted work and
 * leaves them stuck in "Not found" buckets.
 *
 *   - `com.apple.WebKit.PushBundle.<UUID>`  — modern Safari "Add to Home Screen"
 *   - `com.apple.webapp.<…>`                 — older (iOS 16 and before) variant
 *
 * Detected up front so they can be diverted into the manual-apps web-clip
 * path instead.
 */
const WEB_CLIP_BUNDLE_PATTERNS: readonly RegExp[] = [
  /^com\.apple\.WebKit\.PushBundle\./i,
  /^com\.apple\.webapp\./i,
];

export function isLikelyWebClipBundle(
  bundleId: string | null | undefined
): boolean {
  if (typeof bundleId !== "string" || !bundleId) {
    return false;
  }
  return WEB_CLIP_BUNDLE_PATTERNS.some((re) => re.test(bundleId));
}

export interface ImportedAppRow {
  /**
   * Optional developer / seller hint carried through from a structured
   * import (Apple Configurator CSV column like "Vendor" or "Seller").
   * Used as a tie-breaker when iTunes Search returns multiple candidates.
   */
  developer?: string;
  /**
   * True when the source row looks like a Safari web clip / home-screen web
   * app rather than an App Store listing. Apple Configurator surfaces these
   * with an empty Version column *and* an empty Seller/Vendor column — the
   * row has a display name but nothing else. We don't skip the row here
   * (the user might still want to track it manually), but the UI uses this
   * flag to show a "Likely web app" hint when App Store search fails to
   * match, and to offer a one-click path into the manual-apps editor.
   */
  likelyWebClip?: boolean;
  name: string;
}

export interface ParsedImport {
  rows: ImportedAppRow[];
  /** How many rows the source file had (after trimming empties). */
  totalRowsInSource: number;
  /** True when MAX_IMPORT_ROWS trimmed data off the tail. */
  truncated: boolean;
}

/**
 * Backward-compatible helper that returns just the names. Prefer
 * `parseImportedAppRows` when you need developer hints too.
 */
export function parseImportedAppText(text: string): string[] {
  return parseImportedAppRows(text).rows.map((r) => r.name);
}

export function parseImportedAppRows(text: string): ParsedImport {
  // Parse every non-empty line into proper cells up front — this preserves
  // commas inside quoted values (e.g. `"Meta Platforms, Inc."`) which a naive
  // `split(',')` would butcher.
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map(parseCsvRow);

  if (rows.length === 0) {
    return { rows: [], totalRowsInSource: 0, truncated: false };
  }

  // Pick the column that actually holds app names. Single-column files keep
  // working (column 0, no header) while Apple Configurator / Apple Devices /
  // MDM exports — where column 0 is usually UDID or bundle id — now target
  // the right field automatically. We also try to locate a developer /
  // seller / vendor column so we can use it as a secondary match signal.
  const picked = pickAppNameColumn(rows);
  const developerColumn = pickDeveloperColumn(
    rows,
    picked.column,
    picked.startRow > 0
  );
  // Version column only has meaning when the header row told us so — guessing
  // at a version column from data alone is error-prone (dates, size strings,
  // and rank numbers all masquerade as version-ish tokens).
  const versionColumn =
    picked.startRow > 0
      ? pickVersionColumn(rows[0], picked.column, developerColumn)
      : null;

  // Account for the header row if we dropped one so "totalRowsInSource"
  // reflects what the user actually put in.
  const dataRows = rows.slice(picked.startRow);
  const totalRowsInSource = dataRows.length;

  const parsed: ImportedAppRow[] = [];
  for (const row of dataRows) {
    const rawName = row[picked.column] ?? "";
    if (HEADER_CELL_LABELS.has(rawName.trim().toLowerCase())) {
      continue;
    }
    if (looksLikeNonName(rawName)) {
      continue;
    }

    const name = normalizeAppName(rawName);
    if (!name) {
      continue;
    }

    const developer =
      developerColumn === null
        ? undefined
        : sanitizeDeveloperCell(row[developerColumn] ?? "");

    // Apple Configurator hallmark for a Safari web clip (home-screen web app):
    // the row has a name but *both* the Seller/Vendor column and the Version
    // column are blank. Either column alone is too noisy — plenty of real App
    // Store rows have a missing seller, and some free apps in certain regions
    // legitimately have no version string at export time. Requiring both
    // gives us a strong enough signal to surface the hint without triggering
    // false positives on ordinary App Store apps.
    let likelyWebClip = false;
    if (developerColumn !== null && versionColumn !== null) {
      const devCell = (row[developerColumn] ?? "").trim();
      const verCell = (row[versionColumn] ?? "").trim();
      if (!(devCell || verCell)) {
        likelyWebClip = true;
      }
    }

    const entry: ImportedAppRow = developer ? { name, developer } : { name };
    if (likelyWebClip) {
      entry.likelyWebClip = true;
    }
    parsed.push(entry);
  }

  const deduped = dedupeRows(parsed);
  const capped = deduped.slice(0, MAX_IMPORT_ROWS);
  return {
    rows: capped,
    totalRowsInSource,
    truncated: deduped.length > MAX_IMPORT_ROWS,
  };
}

export function parseManualAppText(text: string): string[] {
  const rows = text
    .split(/[\n,]+/)
    .map(normalizeAppName)
    .filter(Boolean);

  return dedupeNames(rows).slice(0, MAX_IMPORT_ROWS);
}

export function extractAppNamesFromOcr(text: string): string[] {
  const rows = text
    .split(/\r?\n/)
    .map(cleanOcrLine)
    .filter(Boolean)
    .filter((line) => !isNoiseLine(line as string)) as string[];

  return dedupeNames(rows).slice(0, MAX_IMPORT_ROWS);
}

/**
 * Parse one CSV row into its cells. Handles RFC-4180-ish quoting: double-quoted
 * cells may contain commas and `""` escapes a literal `"`. We don't attempt to
 * be a full CSV library — exports from Apple Configurator, Apple Devices.app,
 * and typical MDMs all stick to this subset.
 */
function parseCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"') {
        if (row[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((cell) => cell.trim());
}

/** Cells we treat as header labels and never ingest as a name, regardless of case. */
const HEADER_CELL_LABELS = new Set([
  "name",
  "app",
  "app name",
  "application",
  "application name",
  "title",
  "app title",
  "display name",
]);

/** Columns whose header matches one of these is assumed to hold the app name. */
const NAME_HEADER_CANDIDATES = [
  "app name",
  "application name",
  "app title",
  "display name",
  "name",
  "title",
  "app",
  "application",
];

/**
 * Columns that look like the developer / seller / publisher field in a
 * Configurator, Apple Devices, or MDM export. Used as a tie-breaker when
 * iTunes Search returns multiple candidates for the same name.
 */
const DEV_HEADER_CANDIDATES = [
  "seller",
  "vendor",
  "developer",
  "publisher",
  "artist",
  "artist name",
  "author",
  "company",
  "manufacturer",
];

/**
 * Apple device UDIDs come in several flavours:
 *   - 40-char hex (legacy iPhones)
 *   - 25-char mixed with a hyphen at position 8 (e.g. `00008020-001E445C0E830X02`)
 *   - RFC-4122 UUID shape (emitted by some MDMs)
 *
 * Because the exact length varies between Apple Configurator releases we
 * generalise: any pure-hex string that either contains a dash OR is at
 * least 16 hex chars long counts. The short all-hex safety band (≥ 16)
 * keeps legitimate short English words (e.g. "Cafe", "Ace") out of the
 * UDID bucket.
 */
function looksLikeUdid(value: string): boolean {
  const s = value.trim();
  if (!/^[0-9a-f-]+$/i.test(s)) {
    return false;
  }
  const stripped = s.replace(/-/g, "");
  if (stripped.length < 8) {
    return false;
  }
  if (s.includes("-")) {
    return true;
  }
  return stripped.length >= 16;
}

function looksLikeBundleId(value: string): boolean {
  // Reverse-DNS with at least two dots and no spaces.
  return /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+){2,}$/.test(value.trim());
}

function looksLikeVersionToken(value: string): boolean {
  return /^v?\d+(?:\.\d+){1,5}$/i.test(value.trim());
}

function looksLikeSize(value: string): boolean {
  return /^\d+(?:[.,]\d+)?\s?(?:KB|MB|GB|TB)$/i.test(value.trim());
}

function looksLikePrice(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "free" || /^[$€£¥]\s?\d+(?:[.,]\d{1,2})?$/.test(v);
}

/**
 * Cells that obviously aren't an app name: UDIDs, bundle ids, versions,
 * file sizes, prices, or pure numeric/boolean flags. Used both by the
 * column picker and as a row-level safety net.
 */
function looksLikeNonName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (looksLikeUdid(trimmed)) {
    return true;
  }
  if (looksLikeBundleId(trimmed)) {
    return true;
  }
  if (looksLikeVersionToken(trimmed)) {
    return true;
  }
  if (looksLikeSize(trimmed)) {
    return true;
  }
  if (looksLikePrice(trimmed)) {
    return true;
  }
  if (/^(yes|no|true|false|y|n)$/i.test(trimmed)) {
    return true;
  }
  // Pure numeric / timestamp-ish — no letters at all.
  if (!/[A-Za-z]/.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Detect whether the first row is a header. It is if every cell is short
 * (≤40 chars) and at least one looks like a column label rather than data.
 */
function firstRowLooksLikeHeader(row: string[]): boolean {
  if (row.length === 0) {
    return false;
  }
  const allShort = row.every((cell) => cell.length > 0 && cell.length <= 40);
  if (!allShort) {
    return false;
  }
  return row.some((cell) => {
    const lower = cell.trim().toLowerCase();
    return (
      HEADER_CELL_LABELS.has(lower) ||
      NAME_HEADER_CANDIDATES.includes(lower) ||
      lower === "udid" ||
      lower === "identifier" ||
      lower === "bundle id" ||
      lower === "version" ||
      lower === "developer" ||
      lower === "vendor" ||
      lower === "size"
    );
  });
}

/**
 * Pick the column that holds app names. Strategy:
 *   1. If the first row is a header row, match its cells against a list of
 *      known name-column labels (e.g. "Name", "App Name", "Title"). Start
 *      reading from row 1.
 *   2. Otherwise score every column by how many of its cells *look* like
 *      app names (letters present, not a UDID/bundle-id/version/size) and
 *      pick the highest-scoring column.
 *   3. Ties break left-to-right so legacy single-column files keep using
 *      column 0.
 */
function pickAppNameColumn(rows: string[][]): {
  startRow: number;
  column: number;
} {
  if (rows.length === 0) {
    return { startRow: 0, column: 0 };
  }

  if (firstRowLooksLikeHeader(rows[0])) {
    const header = rows[0].map((cell) => cell.trim().toLowerCase());
    for (const candidate of NAME_HEADER_CANDIDATES) {
      const idx = header.indexOf(candidate);
      if (idx !== -1) {
        return { startRow: 1, column: idx };
      }
    }
    // Header exists but didn't expose a recognisable name column. Drop
    // the header row and fall through to scoring against the data rows.
    const scored = scoreColumns(rows.slice(1));
    return { startRow: 1, column: scored };
  }

  return { startRow: 0, column: scoreColumns(rows) };
}

function scoreColumns(rows: string[][]): number {
  if (rows.length === 0) {
    return 0;
  }
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  let bestCol = 0;
  let bestScore = -1;

  for (let col = 0; col < maxCols; col += 1) {
    let score = 0;
    for (const row of rows) {
      const cell = row[col];
      if (cell && !looksLikeNonName(cell)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCol = col;
    }
  }

  return bestCol;
}

/**
 * Try to locate a developer / seller / publisher column. Returns `null` if we
 * couldn't make the call confidently — callers should treat that as "no hint".
 *
 * When a header row exists and contains one of DEV_HEADER_CANDIDATES, we trust
 * it. Otherwise we fall back to a cell heuristic: a developer column usually
 * has text rows that *aren't* the app-name column and aren't bundle-id /
 * UDID / version junk.
 */
function pickDeveloperColumn(
  rows: string[][],
  nameColumn: number,
  hasHeader: boolean
): number | null {
  if (rows.length === 0) {
    return null;
  }

  if (hasHeader) {
    const header = rows[0].map((cell) => cell.trim().toLowerCase());
    for (const cand of DEV_HEADER_CANDIDATES) {
      const idx = header.indexOf(cand);
      if (idx !== -1 && idx !== nameColumn) {
        return idx;
      }
    }
    // No recognisable seller header — don't guess; false positives here
    // would pin the wrong developer during ranking and hurt matches.
    return null;
  }

  // Headerless exports: cautiously look for a non-name column whose cells
  // look like textual seller names (have letters, not bundle-id / UDID / etc).
  const dataRows = rows;
  const maxCols = dataRows.reduce((m, r) => Math.max(m, r.length), 0);
  let bestCol = -1;
  let bestScore = 1; // require at least 2 text-y cells to pick

  for (let col = 0; col < maxCols; col += 1) {
    if (col === nameColumn) {
      continue;
    }
    let score = 0;
    for (const row of dataRows) {
      const cell = row[col];
      if (cell && !looksLikeNonName(cell)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCol = col;
    }
  }

  return bestCol === -1 ? null : bestCol;
}

/**
 * Locate the "version" column in a header row. We only try this when a header
 * exists — guessing at a version column from cell content alone is noisy
 * (rank numbers, file sizes, and dates can all parse as version-ish), and a
 * false positive here would flag normal App Store rows as web clips.
 *
 * Returns the column index, or `null` if no recognisable version header is
 * present (or it collides with the name/developer columns we already picked).
 */
function pickVersionColumn(
  headerRow: string[],
  nameColumn: number,
  developerColumn: number | null
): number | null {
  if (!headerRow || headerRow.length === 0) {
    return null;
  }
  const header = headerRow.map((cell) => cell.trim().toLowerCase());
  const candidates = [
    "version",
    "app version",
    "current version",
    "ver",
    "build",
  ];
  for (const cand of candidates) {
    const idx = header.indexOf(cand);
    if (idx === -1) {
      continue;
    }
    if (idx === nameColumn) {
      continue;
    }
    if (developerColumn !== null && idx === developerColumn) {
      continue;
    }
    return idx;
  }
  return null;
}

/**
 * Clean a developer-column cell. We drop trailing legal suffixes like "Inc.",
 * "LLC" or "Pty Ltd" so the match heuristic can compare "Meta" and
 * "Meta Platforms, Inc." as the same brand.
 */
function sanitizeDeveloperCell(value: string): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  let next = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!next) {
    return;
  }
  if (looksLikeNonName(next)) {
    return;
  }
  if (HEADER_CELL_LABELS.has(next.toLowerCase())) {
    return;
  }
  if (next.length > MAX_NAME_LENGTH) {
    next = next.slice(0, MAX_NAME_LENGTH).trim();
  }
  return next;
}

function dedupeRows(rows: ImportedAppRow[]): ImportedAppRow[] {
  const seen = new Map<string, ImportedAppRow>();
  for (const row of rows) {
    const key = row.name.toLocaleLowerCase();
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, row);
      continue;
    }
    // Merge: prefer the copy with a developer hint attached, but always
    // propagate `likelyWebClip: true` if *any* duplicate saw the signal —
    // a single web-clip-shaped row is enough to warrant the hint.
    const merged: ImportedAppRow =
      !existing.developer && row.developer ? { ...row } : { ...existing };
    if (existing.likelyWebClip || row.likelyWebClip) {
      merged.likelyWebClip = true;
    }
    seen.set(key, merged);
  }
  return [...seen.values()];
}

function cleanOcrLine(line: string): string {
  let next = line.replace(/\s+/g, " ").trim();
  if (!next) {
    return "";
  }

  next = next.replace(/^[•·\-*]+/, "").trim();
  next = next.replace(/\s+\d+(?:\.\d+)?\s?(?:KB|MB|GB|TB)\b.*$/i, "").trim();
  next = next.replace(/\s+last used.*$/i, "").trim();
  next = next.replace(/\s+\d+%.*$/i, "").trim();
  next = next.replace(/^[0-9]+\s*/, "").trim();
  next = normalizeAppName(next);

  return next;
}

function isNoiseLine(line: string): boolean {
  const lower = line.toLowerCase();

  if (!/[a-z]/i.test(line)) {
    return true;
  }
  if (lower.length < 2) {
    return true;
  }
  if (/^\d+(?:\.\d+)?\s?(?:kb|mb|gb|tb)$/i.test(lower)) {
    return true;
  }
  if (/^last used\b/i.test(lower)) {
    return true;
  }
  if (/^\d{1,2}:\d{2}\b/.test(lower)) {
    return true;
  }
  if (/^[\d\s.,%]+$/.test(lower)) {
    return true;
  }
  if (
    NOISE_LINES.some(
      (token) => lower === token || lower.startsWith(`${token} `)
    )
  ) {
    return true;
  }
  if (lower.includes("delete app") || lower.includes("offload app")) {
    return true;
  }

  return false;
}

/**
 * Canonicalise a single user-provided app name:
 * 1. Strip control / non-printable characters (OCR garbage, zero-width glyphs).
 * 2. Collapse whitespace + drop stray leading/trailing punctuation.
 * 3. Strip trailing version suffixes (e.g. "Facebook 500.0.0.46.78", "App 1.2.3"
 *    or "App v2.0") so iTunes Search can find the current App Store listing —
 *    Apple's search is lexical, so "Facebook 500.0.0.46.78" otherwise returns
 *    no results.
 * 4. Enforce a maximum length.
 *
 * Returning '' signals "not a usable name"; callers should filter those out.
 */
export function normalizeAppName(value: string): string {
  if (typeof value !== "string") {
    return "";
  }

  // 1. Remove control characters (C0/C1, zero-width, bidi marks).
  let next = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "");

  // 2. Collapse whitespace + normalise bar-separated words used by some
  //    screenshot OCR tools.
  next = next
    .replace(/\s+/g, " ")
    .replace(/[|]+/g, " ")
    .replace(/\s+[|:;.,]+$/, "")
    .trim();

  // 3. Strip trailing version numbers. We keep "Word 2024" style titles by
  //    only matching things that look like semver: at least two numeric
  //    components, optionally prefixed with "v" or "version".
  next = stripVersionSuffix(next);

  // 4. Enforce length cap (after all cleanup so we don't accidentally truncate
  //    through a version suffix).
  if (next.length > MAX_NAME_LENGTH) {
    next = next.slice(0, MAX_NAME_LENGTH).trim();
  }

  // Reject trivially-short or content-free names.
  if (next.length < 2) {
    return "";
  }
  if (!/[\p{L}\p{N}]/u.test(next)) {
    return "";
  }

  return next;
}

/**
 * Recognises version-ish trailing tokens. Matches:
 *   "Facebook 500.0.0.46.78"           → "Facebook"
 *   "Gmail v1.2.3"                     → "Gmail"
 *   "Settings version 17.4.1"          → "Settings"
 *   "Outlook — 1.2.3"                  → "Outlook"
 *   "MyApp 3.0"                        → "MyApp"
 *   "App (1.2.3)" / "App [v2.0]"       → "App"
 *   "Facebook 1.2.3 (build 4.5)"       → "Facebook"
 *   "My App v2"                        → "My App"
 *
 * Does NOT strip dates/years (so "Word 2024" stays intact — that's a single
 * numeric token, not a version — versions need at least one dot or a
 * leading `v`).
 */
export function stripVersionSuffix(value: string): string {
  let next = value.trim();
  // Loop so we peel composite suffixes like "1.2.3 (build 4.5)" from the right.
  for (let i = 0; i < 4; i += 1) {
    const before = next;
    next = next
      // Trailing bracketed/parenthesised version chunk. Greedy within the
      // brackets so "(build 123.4)" and "[v 2.0]" both match.
      .replace(/\s*[([][^()[\]]*\d+(?:\.\d+)+[^()[\]]*[)\]]\s*$/, "")
      // Dash-prefixed version must be tried *before* the bare numeric form so
      // "Outlook — 1.2.3" collapses to "Outlook" rather than "Outlook —".
      .replace(
        /\s*[—–-]\s*(?:build\s+|version\s+|ver\.?\s*|v\.?\s*)?\d+(?:\.\d+)+\s*$/i,
        ""
      )
      .replace(/\s*[—–-]\s*v\d+\s*$/i, "")
      // "App version 1.2.3" / "App ver. 1.2.3" / "App v1.2.3" / "App 1.2.3"
      .replace(/\s+(?:version\s+|ver\.?\s*|v\.?\s*)?\d+(?:\.\d+)+\s*$/i, "")
      // Trailing "v<digits>" with no dot (e.g. "MyApp v2") — conservative, only
      // with a leading `v` so we don't eat legitimate numeric titles.
      .replace(/\s+v\d+\s*$/i, "")
      // Trim any orphaned trailing separator we may have left behind.
      .replace(/\s*[—–\-|:;,]+\s*$/, "")
      .trim();
    if (next === before) {
      break;
    }
  }
  return next;
}

/**
 * External entry point for callers that want to sanitise arbitrary user input
 * before using it as a name (e.g. from an <input>). Identical pipeline to
 * normalizeAppName, exposed for readability at call sites.
 */
export function sanitizeAppNameInput(value: string): string {
  return normalizeAppName(value);
}

/**
 * Defence-in-depth sanitiser for the `/api/search` payload. Accepts a plain
 * list of names and returns the same canonical list the wizard produces.
 */
export function sanitizeNamesList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const cleaned: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") {
      continue;
    }
    const cleanName = normalizeAppName(raw);
    if (cleanName) {
      cleaned.push(cleanName);
    }
  }
  return dedupeNames(cleaned).slice(0, MAX_IMPORT_ROWS);
}

/**
 * Defence-in-depth sanitiser for the structured payload shape — each entry
 * becomes a canonical `{ name, developer? }`. Invalid entries are dropped.
 */
export function sanitizeRowsList(values: unknown): ImportedAppRow[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const cleaned: ImportedAppRow[] = [];
  for (const raw of values) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const anyRaw = raw as {
      name?: unknown;
      developer?: unknown;
      likelyWebClip?: unknown;
    };
    if (typeof anyRaw.name !== "string") {
      continue;
    }
    const name = normalizeAppName(anyRaw.name);
    if (!name) {
      continue;
    }
    const developer =
      typeof anyRaw.developer === "string"
        ? sanitizeDeveloperCell(anyRaw.developer)
        : undefined;
    const entry: ImportedAppRow = developer ? { name, developer } : { name };
    if (anyRaw.likelyWebClip === true) {
      entry.likelyWebClip = true;
    }
    cleaned.push(entry);
  }
  return dedupeRows(cleaned).slice(0, MAX_IMPORT_ROWS);
}

function dedupeNames(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];

  for (const value of values) {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(value);
  }

  return next;
}
