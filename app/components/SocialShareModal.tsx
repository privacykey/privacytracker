"use client";

/**
 * SocialShareModal — renders an Open Graph–style 1200×630 "head-to-head"
 * comparison image for a shortlist group and offers a PNG download.
 *
 * Layout (left-to-right):
 *   [ brand strip ]
 *   [ source app column ]  [ "VS" ]  [ alternative app column ]
 *   [ footer strip ]
 *
 * Why canvas (instead of next/og or html2canvas):
 * - No new dependencies, no server round-trip. The modal is fully client-
 *   side so the generated image is a true screenshot of a canvas the user
 *   can see, not a server-rendered mystery.
 * - Icons come straight from iTunes / app URL fields already on the group;
 *   CORS failures fall back to a coloured letter tile so we never fail to
 *   paint anything.
 *
 * Data dependencies:
 * - Source app privacy labels live on ShortlistGroup.sourceApp.privacyTypes
 *   (populated server-side in listShortlistGroups).
 * - Alternative privacy labels come from /api/preview via a `loadPreview`
 *   callback the parent provides. The parent (ShortlistView) already owns
 *   a preview cache so this is cheap on repeat opens.
 *
 * The canvas is internally rendered at 2× resolution for crisp exports,
 * then scaled down via CSS for the in-modal preview.
 */

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PrivacyTypeSnapshot } from "../../lib/changelog-types";
import { useFlag } from "../../lib/feature-flags-hooks";
import { CATEGORY_META } from "../../lib/privacy-meta";
import { TYPE_IDENTIFIER_TO_TIER } from "../../lib/privacy-profile";
import type { ShortlistEntry, ShortlistGroup } from "../../lib/shortlist-types";
import { useModalFocus } from "../../lib/use-modal-focus";

interface PreviewLike {
  developer: string;
  iconUrl: string;
  name: string;
  privacyTypes: PrivacyTypeSnapshot[];
}

export interface SocialShareModalProps {
  /**
   * The specific alternative entry to render on the right. Chosen by the
   * user via the per-entry share button, so there's no in-modal picker —
   * if they want to compare a different alternative, they close the modal
   * and click a different row.
   */
  entry: ShortlistEntry;
  /** The shortlist group whose source app appears on the left. */
  group: ShortlistGroup;
  /**
   * Returns the alternative's privacy payload — cached or freshly fetched.
   * The parent owns the /api/preview cache, so repeat opens are free.
   * Resolves to `null` on network errors so we can render a "data pending"
   * placeholder instead of hanging the modal.
   */
  loadPreview: (entry: ShortlistEntry) => Promise<PreviewLike | null>;
  onClose: () => void;
}

/* ─── Canvas palette ─────────────────────────────────────────────────────
 * Matches the app's dark-mode tokens (see app/globals.css :root). Hard-
 * coded here because canvas.ctx can't resolve CSS custom properties. */
const PALETTE = {
  bg: "#0b0f14",
  bgAccent: "#141a22",
  border: "#2a3340",
  text: "#e6edf3",
  textMuted: "#8b98a5",
  textFaint: "#5a6876",
  brand: "#5ac8fa",
  tracking: "#ff453a", // matches --red / .severity-track
  linked: "#ff9f0a", // matches --orange / .severity-linked
  notLinked: "#d8c7a3", // matches --cream / .severity-unlinked
} as const;

type Tier = "tracking" | "linked" | "not_linked";

const TIER_ORDER: Array<{ tier: Tier; color: string }> = [
  { tier: "not_linked", color: PALETTE.notLinked },
  { tier: "linked", color: PALETTE.linked },
  { tier: "tracking", color: PALETTE.tracking },
];

/**
 * Localised label bag passed into the canvas paint functions. Built once
 * inside the React component using `useTranslations('social_share.canvas')`
 * and threaded through so the otherwise-pure paint helpers don't depend on
 * next-intl directly.
 */
interface CanvasLabels {
  comparisonDate: (date: string) => string;
  considerInstead: string;
  currentlyUsing: string;
  fetching: string;
  headToHead: string;
  kicker: Record<Tier, string>;
  noLabels: string;
  sourceAttribution: string;
  tier: Record<Tier, string>;
  /** Localised fallback when the app row has no name on file. */
  unknownApp: string;
  vs: string;
}

/**
 * Count categories per tier from a PrivacyTypeSnapshot[]. A category that
 * appears under two tiers (rare — usually doesn't happen) is counted under
 * each. If the app has no labels at all we return zeros across the board.
 */
function countByTier(
  privacyTypes: PrivacyTypeSnapshot[]
): Record<"tracking" | "linked" | "not_linked", number> {
  const counts = { tracking: 0, linked: 0, not_linked: 0 } as Record<
    "tracking" | "linked" | "not_linked",
    number
  >;
  for (const type of privacyTypes) {
    const tier = TYPE_IDENTIFIER_TO_TIER[type.identifier];
    if (tier === "tracking" || tier === "linked" || tier === "not_linked") {
      counts[tier] += type.categories.length;
    }
  }
  return counts;
}

/**
 * Return the first N category labels for a given tier, so we have some
 * concrete examples to render under the tier counts. Order follows Apple's
 * shelf ordering (we don't re-sort).
 */
function categoriesForTier(
  privacyTypes: PrivacyTypeSnapshot[],
  tier: "tracking" | "linked" | "not_linked",
  limit: number
): string[] {
  const labels: string[] = [];
  for (const type of privacyTypes) {
    if (TYPE_IDENTIFIER_TO_TIER[type.identifier] !== tier) {
      continue;
    }
    for (const cat of type.categories) {
      const label =
        CATEGORY_META[cat.identifier]?.label ?? cat.title ?? cat.identifier;
      if (!labels.includes(label)) {
        labels.push(label);
      }
      if (labels.length >= limit) {
        return labels;
      }
    }
  }
  return labels;
}

/**
 * Attempt to load an image for canvas drawing with CORS enabled. Returns
 * null on any failure (network, CORS, non-existent URL) so callers can
 * fall through to a text-avatar fallback.
 */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Wrap text to a max width, returning up to `maxLines` lines. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (ctx.measureText(attempt).width <= maxWidth) {
      current = attempt;
    } else {
      if (current) {
        lines.push(current);
      }
      current = word;
      if (lines.length === maxLines - 1) {
        // Truncate the last line with an ellipsis if more words remain.
        while (current && ctx.measureText(`${current}…`).width > maxWidth) {
          current = current.slice(0, -1);
        }
        current = `${current}…`;
        break;
      }
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  return lines;
}

/** Round-rect helper — not all browsers' CanvasRenderingContext2D have
 *  ctx.roundRect, so we implement a tiny fallback. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Paint a single app column (icon + name + developer + tier rows + example
 * category list). Used for both the source (left) and alternative (right).
 *
 * `dataState` drives the category rendering:
 *   - 'ready'   : paint the actual tier counts + category previews
 *   - 'loading' : paint a "Fetching privacy data…" placeholder instead
 *   - 'missing' : paint "No privacy labels available" placeholder
 */
function paintAppColumn(
  ctx: CanvasRenderingContext2D,
  opts: {
    x: number;
    width: number;
    label: string;
    appName: string;
    developer: string;
    icon: HTMLImageElement | null;
    privacyTypes: PrivacyTypeSnapshot[];
    dataState: "ready" | "loading" | "missing";
    labels: CanvasLabels;
  }
) {
  const {
    x,
    width,
    label,
    appName,
    developer,
    icon,
    privacyTypes,
    dataState,
    labels,
  } = opts;

  // Column label — small uppercase kicker.
  ctx.fillStyle = PALETTE.textMuted;
  ctx.font = "600 14px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText(label.toUpperCase(), x, 150);

  // Icon + app name row.
  const iconSize = 56;
  const iconY = 178;
  if (icon) {
    // Clip to rounded square before drawing the icon, then draw with a
    // "cover" fit so the image's natural aspect ratio is preserved — we
    // scale it to fill the iconSize box and centre-crop whatever overflows.
    // App Store icons are usually square, but some come through
    // non-square (fallback fetches, redirects to a generic placeholder);
    // without this the icon appears stretched.
    ctx.save();
    roundRect(ctx, x, iconY, iconSize, iconSize, 12);
    ctx.clip();
    const natW = icon.naturalWidth || iconSize;
    const natH = icon.naturalHeight || iconSize;
    const coverScale = Math.max(iconSize / natW, iconSize / natH);
    const drawW = natW * coverScale;
    const drawH = natH * coverScale;
    const drawX = x + (iconSize - drawW) / 2;
    const drawY = iconY + (iconSize - drawH) / 2;
    ctx.drawImage(icon, drawX, drawY, drawW, drawH);
    ctx.restore();
  } else {
    // Fallback: first-letter tile in a subtle accent colour.
    roundRect(ctx, x, iconY, iconSize, iconSize, 12);
    ctx.fillStyle = PALETTE.bgAccent;
    ctx.fill();
    ctx.fillStyle = PALETTE.text;
    ctx.font = "700 28px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      (appName || "?").charAt(0).toUpperCase(),
      x + iconSize / 2,
      iconY + iconSize / 2 + 2
    );
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  // App name (big), wrapped if too long. `width - iconSize - 16` leaves
  // space for the icon and its gutter.
  ctx.fillStyle = PALETTE.text;
  ctx.font = "700 30px system-ui, -apple-system, Segoe UI, sans-serif";
  const nameLines = wrapText(
    ctx,
    appName || labels.unknownApp,
    width - iconSize - 16,
    2
  );
  for (let i = 0; i < nameLines.length; i++) {
    ctx.fillText(nameLines[i], x + iconSize + 16, iconY + i * 34);
  }

  // Developer underneath (smaller, dimmed).
  ctx.fillStyle = PALETTE.textMuted;
  ctx.font = "400 16px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText(
    developer || "",
    x + iconSize + 16,
    iconY + nameLines.length * 34 + 4
  );

  // ── Tier rows ────────────────────────────────────────────────────────
  // Three rows of "●  Label                                       12"
  // A divider separates the app header from the data block.
  const divY = 278;
  ctx.strokeStyle = PALETTE.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, divY);
  ctx.lineTo(x + width, divY);
  ctx.stroke();

  if (dataState !== "ready") {
    ctx.fillStyle = PALETTE.textFaint;
    ctx.font = "400 15px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.fillText(
      dataState === "loading" ? labels.fetching : labels.noLabels,
      x,
      divY + 24
    );
    return;
  }

  const counts = countByTier(privacyTypes);
  let rowY = divY + 22;
  for (const tier of TIER_ORDER) {
    // Dot.
    ctx.beginPath();
    ctx.fillStyle = tier.color;
    ctx.arc(x + 6, rowY + 11, 6, 0, Math.PI * 2);
    ctx.fill();

    // Label.
    ctx.fillStyle = PALETTE.text;
    ctx.font = "500 17px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.fillText(labels.tier[tier.tier], x + 22, rowY);

    // Count (right-aligned within the column).
    const count = counts[tier.tier];
    ctx.fillStyle = count === 0 ? PALETTE.textMuted : PALETTE.text;
    ctx.font = "700 18px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(String(count), x + width, rowY);
    ctx.textAlign = "left";

    rowY += 30;
  }

  // ── Example category chips ───────────────────────────────────────────
  // We surface the first 3 "linked" categories as a plain-text chip line
  // — these are the categories most users want at a glance ("contact info,
  // location, identifiers"). If there are no linked categories we fall
  // back to tracking categories, then not-linked.
  let chipSource: "linked" | "tracking" | "not_linked" = "linked";
  let examples = categoriesForTier(privacyTypes, "linked", 4);
  if (examples.length === 0) {
    chipSource = "tracking";
    examples = categoriesForTier(privacyTypes, "tracking", 4);
  }
  if (examples.length === 0) {
    chipSource = "not_linked";
    examples = categoriesForTier(privacyTypes, "not_linked", 4);
  }
  if (examples.length > 0) {
    ctx.fillStyle = PALETTE.textMuted;
    ctx.font = "600 12px system-ui, -apple-system, Segoe UI, sans-serif";
    const tag = labels.kicker[chipSource];
    ctx.fillText(tag, x, rowY + 8);
    ctx.fillStyle = PALETTE.text;
    ctx.font = "400 14px system-ui, -apple-system, Segoe UI, sans-serif";
    const joined = examples.join(" · ");
    const truncated = wrapText(ctx, joined, width, 2);
    for (let i = 0; i < truncated.length; i++) {
      ctx.fillText(truncated[i], x, rowY + 28 + i * 20);
    }
  }
}

/**
 * Paint the full 1200×630 social share. Mutates the canvas directly.
 *
 * The render path assumes `canvas.width` / `canvas.height` have already
 * been set to 2× logical size and `ctx.scale(2, 2)` has been applied.
 *
 * Images must be pre-loaded by the caller — making this function fully
 * synchronous is important for correctness: when `altState` transitions
 * (loading → ready, ready → error), the effect that drives the paint can
 * re-run mid-flight, and with async loadImage calls inside, two paints
 * could interleave and cause residual pixels from the previous render to
 * overlap the new one (e.g. stale tier text on top of a fresh "no privacy
 * labels available" placeholder). Pre-loading in the effect with a
 * cancellation flag eliminates that race entirely.
 */
function paintSocialShare(
  canvas: HTMLCanvasElement,
  opts: {
    source: PreviewLike;
    alt: PreviewLike | null;
    altLoading: boolean;
    sourceIcon: HTMLImageElement | null;
    altIcon: HTMLImageElement | null;
    labels: CanvasLabels;
  }
) {
  const { labels } = opts;
  const W = 1200;
  const H = 630;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  // Background — always fully clears the canvas before anything else
  // paints, so re-renders don't accumulate pixels from earlier states.
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, W, H);

  // Subtle top-bar band so the brand strip has a home.
  ctx.fillStyle = PALETTE.bgAccent;
  ctx.fillRect(0, 0, W, 80);
  ctx.strokeStyle = PALETTE.border;
  ctx.beginPath();
  ctx.moveTo(0, 80);
  ctx.lineTo(W, 80);
  ctx.stroke();

  // Brand strip: shield glyph + "privacytracker".
  // The shield is drawn with vector paths so we don't depend on any font
  // that might not be installed. It's the badge shape from the nav logo.
  ctx.save();
  ctx.translate(56, 26);
  ctx.fillStyle = PALETTE.brand;
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(32, 6);
  ctx.lineTo(32, 18);
  ctx.quadraticCurveTo(32, 30, 16, 36);
  ctx.quadraticCurveTo(0, 30, 0, 18);
  ctx.lineTo(0, 6);
  ctx.closePath();
  ctx.fill();
  // inner check
  ctx.strokeStyle = PALETTE.bg;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(8, 18);
  ctx.lineTo(14, 24);
  ctx.lineTo(24, 12);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = PALETTE.text;
  ctx.font = "700 22px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText("privacytracker", 104, 44);
  ctx.textBaseline = "top";

  // Right-side kicker.
  ctx.fillStyle = PALETTE.textMuted;
  ctx.font = "500 14px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(labels.headToHead, W - 56, 33);
  ctx.textAlign = "left";

  // ── Columns ──────────────────────────────────────────────────────────
  // Layout: left column (56 → 540), center VS (540 → 660), right column
  // (660 → 1144). That gives each app ~484px of width and a 120px VS
  // gutter — enough space for a big, eye-catching "VS".
  paintAppColumn(ctx, {
    x: 56,
    width: 484,
    label: labels.currentlyUsing,
    appName: opts.source.name,
    developer: opts.source.developer,
    icon: opts.sourceIcon,
    privacyTypes: opts.source.privacyTypes,
    dataState: opts.source.privacyTypes.length > 0 ? "ready" : "missing",
    labels,
  });

  paintAppColumn(ctx, {
    x: 660,
    width: 484,
    label: labels.considerInstead,
    appName: opts.alt?.name ?? "—",
    developer: opts.alt?.developer ?? "",
    icon: opts.altIcon,
    privacyTypes: opts.alt?.privacyTypes ?? [],
    dataState: opts.altLoading
      ? "loading"
      : opts.alt && opts.alt.privacyTypes.length > 0
        ? "ready"
        : "missing",
    labels,
  });

  // ── Center "VS" token ────────────────────────────────────────────────
  // Positioned so its centre sits right on the header divider (y=80) —
  // half the halo circle overlaps the dark-accent brand strip, half
  // overlaps the main body. That draws the eye straight to the
  // comparison and makes the header feel integrated with the content
  // rather than a floating strip. Painted last so it sits on top of the
  // header band and the column label underneath.
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = W / 2;
  const cy = 80; // sit on the header boundary
  // Halo circle for weight.
  ctx.fillStyle = PALETTE.bgAccent;
  ctx.beginPath();
  ctx.arc(cx, cy, 54, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = PALETTE.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  // The word itself.
  ctx.fillStyle = PALETTE.text;
  ctx.font = "900 44px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText(labels.vs, cx, cy + 2);
  ctx.restore();

  // ── Footer strip ─────────────────────────────────────────────────────
  // Date (so it's clear when this snapshot was generated) + a muted
  // tagline so the image still reads as "from privacytracker" if cropped.
  ctx.fillStyle = PALETTE.bgAccent;
  ctx.fillRect(0, H - 60, W, 60);
  ctx.strokeStyle = PALETTE.border;
  ctx.beginPath();
  ctx.moveTo(0, H - 60);
  ctx.lineTo(W, H - 60);
  ctx.stroke();

  const now = new Date();
  const dateStr = now.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  ctx.fillStyle = PALETTE.textMuted;
  ctx.font = "500 14px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(labels.comparisonDate(dateStr), 56, H - 30);

  ctx.textAlign = "right";
  ctx.fillText(labels.sourceAttribution, W - 56, H - 30);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

export function SocialShareModal({
  group,
  entry,
  onClose,
  loadPreview,
}: SocialShareModalProps) {
  // Wave I: global social-share gate. Off by default for `self` audience —
  // sharing your own privacy fingerprint is a deliberate opt-in, not a
  // workflow assumption. Loved-one rule turns it on so guardians sharing
  // recommendations have the affordance available.
  const socialShareOn = useFlag("flag.global.social_share") === "on";

  // i18n. Modal chrome strings live under `social_share.*`; the strings
  // baked into the canvas image live under `social_share.canvas.*` and
  // are bundled into a `CanvasLabels` bag passed to the paint helpers.
  const tShare = useTranslations("social_share");
  const tCanvas = useTranslations("social_share.canvas");

  // This component is only mounted while open, so open=true. closeOnEscape
  // is false because the existing keydown handler owns both Escape and
  // Cmd/Ctrl+C to avoid double-firing.
  const dialogCardRef = useModalFocus<HTMLDivElement>({
    open: true,
    onClose,
    closeOnEscape: false,
  });

  const [altState, setAltState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; data: PreviewLike }
    | { kind: "error" }
  >({ kind: "idle" });

  // Drives the copy-to-clipboard button label so the user gets immediate
  // feedback that the write succeeded (or failed). Auto-reverts to 'idle'
  // after ~1.8s so the button reads as "Copy to clipboard" again.
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle"
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Load the alternative preview whenever the selected entry changes.
  // `loadPreview` is intentionally excluded from the dep list — its
  // identity changes every time the parent's preview cache updates, and
  // including it would cause a "loading" flicker the moment we
  // successfully populate the cache for this entry.
  useEffect(() => {
    let cancelled = false;
    setAltState({ kind: "loading" });
    loadPreview(entry)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result) {
          setAltState({ kind: "error" });
          return;
        }
        setAltState({ kind: "ready", data: result });
      })
      .catch(() => {
        if (!cancelled) {
          setAltState({ kind: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  // ── Paint pipeline ───────────────────────────────────────────────────
  // We pre-load the two icons inside this effect and only call the
  // (synchronous) paint function once both have resolved. The cancelled
  // flag guarantees a stale paint from a previous render never reaches
  // the canvas — before this refactor, async loadImage calls inside
  // paintSocialShare could interleave with a newer paint, leaving
  // residual pixels like a stale tier list overlapping a fresh
  // "no privacy labels available" placeholder.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    // 2× internal resolution for crisp exports.
    const PIXEL_RATIO = 2;
    const W = 1200;
    const H = 630;
    canvas.width = W * PIXEL_RATIO;
    canvas.height = H * PIXEL_RATIO;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.setTransform(PIXEL_RATIO, 0, 0, PIXEL_RATIO, 0, 0);

    const source: PreviewLike = {
      name: group.sourceApp.name,
      developer: group.sourceApp.developer,
      iconUrl: group.sourceApp.iconUrl,
      privacyTypes: group.sourceApp.privacyTypes ?? [],
    };

    const alt: PreviewLike | null =
      altState.kind === "ready"
        ? altState.data
        : {
            name: entry.candidateName,
            developer: entry.candidateDeveloper,
            iconUrl: entry.candidateIconUrl,
            privacyTypes: [], // filled in when altState goes ready
          };

    const canvasLabels: CanvasLabels = {
      currentlyUsing: tCanvas("currently_using"),
      considerInstead: tCanvas("consider_instead"),
      vs: tCanvas("vs"),
      headToHead: tCanvas("head_to_head"),
      comparisonDate: (date: string) => tCanvas("comparison_date", { date }),
      sourceAttribution: tCanvas("source_attribution"),
      fetching: tCanvas("fetching"),
      noLabels: tCanvas("no_labels"),
      tier: {
        tracking: tCanvas("tier_tracking"),
        linked: tCanvas("tier_linked"),
        not_linked: tCanvas("tier_not_linked"),
      },
      kicker: {
        tracking: tCanvas("kicker_tracking"),
        linked: tCanvas("kicker_linked"),
        not_linked: tCanvas("kicker_not_linked"),
      },
      unknownApp: tCanvas("unknown_app"),
    };

    let cancelled = false;
    (async () => {
      const [sourceIcon, altIcon] = await Promise.all([
        loadImage(source.iconUrl),
        alt ? loadImage(alt.iconUrl) : Promise.resolve(null),
      ]);
      if (cancelled) {
        return;
      }
      paintSocialShare(canvas, {
        source,
        alt,
        altLoading: altState.kind === "loading",
        sourceIcon,
        altIcon,
        labels: canvasLabels,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [group, entry, altState, tCanvas]);

  const handleDownload = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const slug = (s: string) =>
        s
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 30) || "app";
      a.download = `${slug(group.sourceApp.name)}-vs-${slug(entry.candidateName)}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, "image/png");
  }, [group.sourceApp.name, entry.candidateName]);

  /**
   * Copy the current canvas as a PNG to the OS clipboard. Uses the
   * Promise-in-ClipboardItem pattern (recommended by MDN) so Safari's
   * user-activation requirement is satisfied — the ClipboardItem gets
   * constructed synchronously inside the click handler, even though the
   * underlying toBlob work is async. Falls back to an error toast when:
   *   - `ClipboardItem` isn't available (older Firefox / very old Safari)
   *   - `navigator.clipboard.write` is blocked (insecure context, denied
   *     permission, or a browser that gates image MIME types)
   * In that fallback case we surface "Copy failed" on the button and also
   * trigger a download as a pragmatic consolation — the user asked to
   * grab the image, downloading is the closest thing to copying that we
   * can guarantee works.
   */
  const handleCopy = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    // Feature detection — `ClipboardItem` is the last holdout on older
    // Firefox; `navigator.clipboard.write` requires a secure context.
    const canWriteImage =
      typeof window !== "undefined" &&
      typeof window.ClipboardItem === "function" &&
      !!navigator.clipboard?.write;
    if (!canWriteImage) {
      setCopyState("error");
      handleDownload();
      window.setTimeout(() => setCopyState("idle"), 1800);
      return;
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          // Passing a Promise<Blob> rather than an already-awaited Blob
          // lets Safari correlate the clipboard write with the click's
          // user-activation token. Awaiting the blob first would break it.
          "image/png": new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => {
              if (blob) {
                resolve(blob);
              } else {
                reject(new Error("Canvas toBlob returned null"));
              }
            }, "image/png");
          }),
        }),
      ]);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }, [handleDownload]);

  // Keyboard shortcuts while the modal is open:
  //   - Escape → close
  //   - Cmd/Ctrl+C → copy the image to the clipboard
  //
  // We only intercept Cmd/Ctrl+C when there's no active text selection.
  // Otherwise the user is probably trying to copy selected text (e.g.
  // the app names from the title bar) and the native copy should win.
  // The global KeyboardShortcuts component explicitly lets non-K/Z
  // Cmd combos fall through, so our listener is the only thing watching
  // for this shortcut — no conflict.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const isCopyCombo =
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "c" || e.key === "C");
      if (!isCopyCombo) {
        return;
      }
      const selection =
        typeof window === "undefined" ? null : window.getSelection();
      const hasTextSelection = !!selection && selection.toString().length > 0;
      if (hasTextSelection) {
        return; // let the browser copy the selected text
      }
      e.preventDefault();
      void handleCopy();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, handleCopy]);

  // Hooks above must run unconditionally to keep React's hook order stable.
  // Bail out here if the global social-share gate is off — render nothing
  // and let the parent's onClose drive the close.
  if (!socialShareOn) {
    return null;
  }

  return (
    <div
      aria-labelledby="social-share-title"
      aria-modal="true"
      className="social-share-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      role="dialog"
    >
      <div className="social-share-dialog" ref={dialogCardRef} tabIndex={-1}>
        <div className="social-share-header">
          <div>
            <h2 className="social-share-title" id="social-share-title">
              {tShare("title", {
                source: group.sourceApp.name,
                alt: entry.candidateName,
              })}
            </h2>
            <p className="social-share-subtitle">{tShare("subtitle")}</p>
          </div>
          <button
            aria-label={tShare("close_aria")}
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        <div className="social-share-canvas-wrap">
          <canvas
            className="social-share-canvas"
            ref={canvasRef}
            // Logical display size — the underlying pixel buffer is 2×
            // this, so scaling it down keeps the preview crisp.
            style={{
              width: "100%",
              maxWidth: 720,
              height: "auto",
              aspectRatio: "1200 / 630",
            }}
          />
          {altState.kind === "loading" && (
            <div className="social-share-canvas-hint" role="status">
              {tShare("loading_alt", { appName: entry.candidateName })}
            </div>
          )}
          {altState.kind === "error" && (
            <div
              className="social-share-canvas-hint social-share-canvas-hint-error"
              role="status"
            >
              {tShare("load_error")}
            </div>
          )}
        </div>

        <div className="social-share-actions">
          <button
            className="btn btn-primary"
            disabled={altState.kind === "loading"}
            onClick={handleDownload}
            type="button"
          >
            {tShare("download_png")}
          </button>
          {/* Copy to clipboard — writes the image as an `image/png` to the
              OS clipboard so the user can paste it directly into a social
              post, Slack, or a messaging thread without saving a file
              first. The button's label doubles as a copy-feedback affordance
              so we don't need a separate toast. Cmd/Ctrl+C also fires this
              while the modal is open — see the keydown effect above. */}
          <button
            aria-live="polite"
            className="btn btn-secondary"
            disabled={altState.kind === "loading"}
            onClick={() => {
              void handleCopy();
            }}
            title={tShare("copy_title")}
            type="button"
          >
            {copyState === "copied"
              ? tShare("copied")
              : copyState === "error"
                ? tShare("copy_failed")
                : tShare("copy_to_clipboard")}
          </button>
          <button className="btn btn-ghost" onClick={onClose} type="button">
            {tShare("done")}
          </button>
        </div>
      </div>
    </div>
  );
}
