/**
 * Privacy-policy diff utilities.
 *
 * Policies are prose documents, typically a few hundred to a few thousand
 * lines once normalised. We run a straightforward LCS line-diff, then refine
 * adjacent removed/added blocks with a word-level diff so the UI can
 * highlight exactly which words shifted — the same idea as
 * `git diff --word-diff`.
 *
 * We keep this in-repo (no `diff` npm package) to hold the runtime-deps
 * list as tight as the rest of the codebase. The O(N*M) DP is fine for
 * the bounded inputs we care about; a safety cap (`MAX_LINES`,
 * `MAX_WORDS_PER_LINE`) degrades gracefully to a whole-line diff on
 * pathological payloads rather than allocating a 25M-cell table.
 */

/** Hard cap on lines per side before we fall back to a truncated diff. */
const MAX_LINES = 2000;

/**
 * Hard cap on words per line before we skip word-level refinement for
 * that pair. A 500-word line is already a red flag — policies don't
 * usually have those — and the word DP is O(words²) per line.
 */
const MAX_WORDS_PER_LINE = 400;

export interface PolicyDiffWord {
  text: string;
  type: "unchanged" | "added" | "removed";
}

export interface PolicyDiffLine {
  /** Raw line text (no trailing newline). */
  text: string;
  type: "unchanged" | "added" | "removed";
  /**
   * Populated for `added` / `removed` lines when the diff detected a
   * close counterpart on the other side: holds the word-level split so
   * the UI can emphasise just the swapped words. `undefined` for
   * standalone lines (pure insertion / deletion with no peer).
   */
  words?: PolicyDiffWord[];
}

export interface PolicyDiffStats {
  added: number;
  removed: number;
  /** True when at least one side hit MAX_LINES and the diff is lossy. */
  truncated: boolean;
  unchanged: number;
}

export interface PolicyDiffResult {
  lines: PolicyDiffLine[];
  stats: PolicyDiffStats;
}

/**
 * Compute a line-level diff between two blobs of policy text with
 * word-level refinement on paired add/remove runs. Both inputs may be
 * empty; the result is well-formed in every case (including "both
 * empty", which returns `{ lines: [], stats: all zeros }`).
 */
export function diffPolicyTexts(
  oldText: string,
  newText: string
): PolicyDiffResult {
  const oldLinesAll = splitLines(oldText);
  const newLinesAll = splitLines(newText);

  const truncated =
    oldLinesAll.length > MAX_LINES || newLinesAll.length > MAX_LINES;
  const oldLines = oldLinesAll.slice(0, MAX_LINES);
  const newLines = newLinesAll.slice(0, MAX_LINES);

  const rawOps = lcsDiff(oldLines, newLines);

  // Walk the ops stream, grouping contiguous runs of `removed` + `added`
  // so we can refine each pair with a word-level diff. Unchanged lines
  // pass through verbatim.
  const lines: PolicyDiffLine[] = [];
  let added = 0,
    removed = 0,
    unchanged = 0;

  let i = 0;
  while (i < rawOps.length) {
    const op = rawOps[i];
    if (op.type === "unchanged") {
      lines.push({ type: "unchanged", text: op.text });
      unchanged++;
      i++;
      continue;
    }

    // Collect the full run of non-unchanged ops.
    const runRemoved: string[] = [];
    const runAdded: string[] = [];
    while (i < rawOps.length && rawOps[i].type !== "unchanged") {
      const o = rawOps[i];
      if (o.type === "removed") {
        runRemoved.push(o.text);
      } else {
        runAdded.push(o.text);
      }
      i++;
    }

    // Pair by position: removed[k] ↔ added[k] for k up to min. Leftovers
    // on the longer side render as standalone adds or removes.
    const pairs = Math.min(runRemoved.length, runAdded.length);
    for (let k = 0; k < pairs; k++) {
      const oldLine = runRemoved[k];
      const newLine = runAdded[k];
      const words = refineWordDiff(oldLine, newLine);
      lines.push({
        type: "removed",
        text: oldLine,
        words: words ? words.filter((w) => w.type !== "added") : undefined,
      });
      lines.push({
        type: "added",
        text: newLine,
        words: words ? words.filter((w) => w.type !== "removed") : undefined,
      });
      removed++;
      added++;
    }
    for (let k = pairs; k < runRemoved.length; k++) {
      lines.push({ type: "removed", text: runRemoved[k] });
      removed++;
    }
    for (let k = pairs; k < runAdded.length; k++) {
      lines.push({ type: "added", text: runAdded[k] });
      added++;
    }
  }

  return { lines, stats: { added, removed, unchanged, truncated } };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  // Normalise CRLF so diffs don't light up every line just because the
  // file switched newline styles between captures.
  return text.replace(/\r\n/g, "\n").split("\n");
}

interface DiffOp {
  text: string;
  type: "unchanged" | "added" | "removed";
}

/**
 * LCS-backed diff over string arrays. Returns an ordered op stream.
 * Optimised pass: common prefix and suffix are stripped before the DP,
 * which in practice means most policies (where 90%+ of lines are
 * identical) skip almost all of the quadratic work.
 */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const ops: DiffOp[] = [];

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    ops.push({ type: "unchanged", text: a[prefix] });
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a.at(1 + suffix) === b.at(1 + suffix)
  ) {
    suffix++;
  }

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  const midOps = lcsDiffCore(aMid, bMid);
  for (const op of midOps) {
    ops.push(op);
  }

  for (let k = b.length - suffix; k < b.length; k++) {
    // Using b for the trailing block since it matches a in every position
    // by construction; picking b keeps the data self-consistent.
    ops.push({ type: "unchanged", text: b[k] });
  }

  return ops;
}

function lcsDiffCore(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) {
    return [];
  }
  if (n === 0) {
    return b.map((t) => ({ type: "added" as const, text: t }));
  }
  if (m === 0) {
    return a.map((t) => ({ type: "removed" as const, text: t }));
  }

  // Flat Int32Array DP to keep GC pressure low. dp[i*(m+1) + j] holds the
  // LCS length of a[i..] vs b[j..]. Walking from the bottom-right lets us
  // reconstruct the diff by taking (i+1,j) vs (i,j+1) at each step.
  const dp = new Int32Array((n + 1) * (m + 1));
  const stride = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    const rowBase = i * stride;
    const nextBase = (i + 1) * stride;
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[rowBase + j] = dp[nextBase + j + 1] + 1;
      } else {
        const down = dp[nextBase + j];
        const right = dp[rowBase + j + 1];
        dp[rowBase + j] = down >= right ? down : right;
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "unchanged", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
      ops.push({ type: "removed", text: a[i] });
      i++;
    } else {
      ops.push({ type: "added", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "removed", text: a[i++] });
  }
  while (j < m) {
    ops.push({ type: "added", text: b[j++] });
  }
  return ops;
}

/**
 * Word-level diff between two lines that got paired up during the
 * line-diff. Returns a unified word stream (`type` + `text`), preserving
 * whitespace as unchanged tokens so the UI can reconstruct the line
 * verbatim. `null` means the pair is too large / noisy to refine.
 *
 * Splits on whitespace boundaries while keeping the spaces themselves as
 * tokens — that way "word → word " doesn't spuriously flag trailing
 * whitespace changes, and re-joining `.text` restores the original line.
 */
function refineWordDiff(
  oldLine: string,
  newLine: string
): PolicyDiffWord[] | null {
  const oldTokens = tokeniseLine(oldLine);
  const newTokens = tokeniseLine(newLine);
  if (
    oldTokens.length > MAX_WORDS_PER_LINE ||
    newTokens.length > MAX_WORDS_PER_LINE
  ) {
    return null;
  }

  const ops = lcsDiff(oldTokens, newTokens);
  return ops.map((op) => ({ type: op.type, text: op.text }));
}

function tokeniseLine(line: string): string[] {
  // Capture groups keep the separators in the output, so we get an
  // interleaved [word, ws, word, ws, ...] stream.
  const parts = line.split(/(\s+)/);
  return parts.filter((p) => p.length > 0);
}
