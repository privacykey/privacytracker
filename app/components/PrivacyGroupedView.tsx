"use client";

import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { categoryLabel, severityLabel } from "../../lib/i18n-meta";
import { CATEGORY_META, SEVERITY_CONFIG } from "../../lib/privacy-meta";
import InfoTooltip from "./InfoTooltip";

// ── Types ─────────────────────────────────────────────────────────────

interface AppRef {
  iconUrl?: string;
  id: string;
  name: string;
}
interface CategoryEntry {
  apps: AppRef[];
  identifier: string;
  riskWeight?: number;
  title: string;
}
interface PrivacyGroup {
  categories: CategoryEntry[];
  detail?: string;
  identifier: string;
  title: string;
}

// ── Main component ────────────────────────────────────────────────────

export default function PrivacyGroupedView({
  initialData,
}: {
  initialData: PrivacyGroup[];
}) {
  const tMap = useTranslations("privacy_map");
  const [search, setSearch] = useState("");

  // If the user landed here via a deep-link like
  // `/dashboard/privacy#cat-DATA_LINKED_TO_YOU-USER_CONTENT` we capture both
  // the privacy-type id and the category id so sibling categories with the
  // same identifier under a different privacy type (e.g. Usage Data appears
  // under both Linked and Not Linked) are disambiguated.
  const [target, setTarget] = useState<{
    typeId: string;
    catId: string;
  } | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const readHash = () => {
      const hash = window.location.hash;
      if (!hash.startsWith("#cat-")) {
        setTarget(null);
        return;
      }
      const rest = decodeURIComponent(hash.slice("#cat-".length));
      // Privacy-type identifiers (DATA_USED_TO_TRACK_YOU, DATA_LINKED_TO_YOU,
      // DATA_NOT_LINKED_TO_YOU) use underscores only — no hyphens — so the
      // first hyphen reliably separates the type id from the category id.
      const sep = rest.indexOf("-");
      if (sep > 0 && sep < rest.length - 1) {
        setTarget({ typeId: rest.slice(0, sep), catId: rest.slice(sep + 1) });
      } else {
        // Back-compat: if there's no scope prefix, treat the whole string as
        // a bare category id (first match wins).
        setTarget({ typeId: "", catId: rest });
      }
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  const filtered = initialData
    .map((group) => ({
      ...group,
      categories: group.categories.filter(
        (c) =>
          !search ||
          c.title.toLowerCase().includes(search.toLowerCase()) ||
          c.apps.some((a) =>
            a.name.toLowerCase().includes(search.toLowerCase())
          )
      ),
    }))
    .filter((group) => group.categories.length > 0);

  if (initialData.length === 0) {
    return (
      <div className="page-container">
        <div className="empty-state">
          <div className="empty-state-icon">🗺</div>
          <div className="empty-state-title">{tMap("empty_no_data_title")}</div>
          <p className="empty-state-text">
            {tMap("empty_no_data_pre")}
            <Link href="/onboard" style={{ color: "var(--blue)" }}>
              {tMap("empty_no_data_link")}
            </Link>
            {tMap("empty_no_data_post")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tMap("page_title")}</h1>
          <p className="page-subtitle">{tMap("page_subtitle")}</p>
        </div>
      </div>

      <div className="toolbar">
        <div className="search-input-wrap">
          <span className="search-icon">⌕</span>
          <input
            className="search-input"
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tMap("filter_placeholder")}
            type="search"
            value={search}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🔍</div>
          <div className="empty-state-title">{tMap("empty_no_match")}</div>
        </div>
      ) : (
        filtered.map((group) => (
          <PrivacySection
            group={group}
            key={group.identifier}
            target={target}
          />
        ))
      )}
    </div>
  );
}

function PrivacySection({
  group,
  target,
}: {
  group: PrivacyGroup;
  target: { typeId: string; catId: string } | null;
}) {
  // Localised severity label — falls back to the English meta label
  // (then the group's own title) when the identifier hasn't been
  // mapped into the `severity.*` namespace yet.
  const tSev = useTranslations("severity");
  const config = SEVERITY_CONFIG[group.identifier];
  const cls = config?.cls ?? "severity-none";
  const label =
    severityLabel(tSev, group.identifier) ?? config?.label ?? group.title;
  const icon = config?.icon ?? "🔍";
  const totalApps = new Set(
    group.categories.flatMap((c) => c.apps.map((a) => a.id))
  ).size;

  // A card is the deep-link target when:
  //   (a) the hash specified this section's privacy type AND the category id
  //       matches (the common case — scoped deep-links), or
  //   (b) the hash is the legacy bare-category form with no type prefix, in
  //       which case any section's matching card can claim it.
  const isCardTarget = (catIdentifier: string): boolean => {
    if (!target) {
      return false;
    }
    if (target.typeId && target.typeId !== group.identifier) {
      return false;
    }
    return target.catId === catIdentifier;
  };

  return (
    <section className="privacy-section">
      <div className="pmap-section-header">
        <div className="pmap-section-header-main">
          <span className={`severity-badge ${cls}`}>
            <span aria-hidden="true">{icon}</span> {label}
          </span>
          {config?.description && <InfoTooltip text={config.description} />}
        </div>
        <span className="pmap-section-count">
          {group.categories.length} categor
          {group.categories.length === 1 ? "y" : "ies"} · {totalApps} app
          {totalApps === 1 ? "" : "s"}
        </span>
        {group.detail && <p className="pmap-section-detail">{group.detail}</p>}
      </div>

      <div className="pmap-grid">
        {group.categories.map((cat) => (
          <CategoryCard
            anchorId={`cat-${group.identifier}-${cat.identifier}`}
            category={cat}
            isTarget={isCardTarget(cat.identifier)}
            key={cat.identifier}
          />
        ))}
      </div>
    </section>
  );
}

function CategoryCard({
  category,
  anchorId,
  isTarget,
}: {
  category: CategoryEntry;
  anchorId: string;
  isTarget: boolean;
}) {
  const tMap = useTranslations("privacy_map");
  // Open the card automatically when it is the deep-link target so the user
  // immediately sees the full app list they came for.
  const [expanded, setExpanded] = useState(isTarget);
  const [pulsing, setPulsing] = useState(false);
  // Category card's localised label — same fallback chain as the
  // severity badge above. Local meta still drives icon + colour.
  const tCat = useTranslations("category");
  const meta = CATEGORY_META[category.identifier];
  const cardRef = useRef<HTMLDivElement>(null);

  // Scroll + pulse when this card is the deep-link target. Drives the pulse
  // through React state (rather than classList.add) so the reconciler can't
  // accidentally strip the class during a concurrent re-render.
  useEffect(() => {
    if (!isTarget) {
      return;
    }
    const el = cardRef.current;
    if (!el) {
      return;
    }
    setExpanded(true);
    setPulsing(false);
    // One-frame delay: gives the browser time to paint the neutral state
    // before we flip to `pulsing=true`, which guarantees the keyframes
    // animate from 0% instead of skipping straight to the settled values.
    const rafId = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setPulsing(true);
    });
    const timer = window.setTimeout(() => setPulsing(false), 1900);
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(timer);
    };
  }, [isTarget]);

  const MAX_ICONS = 5;
  const shown = category.apps.slice(0, MAX_ICONS);
  const extra = category.apps.length - MAX_ICONS;

  const label =
    categoryLabel(tCat, category.identifier) ?? meta?.label ?? category.title;
  const icon = meta?.icon ?? "📂";

  // Intrinsically sensitive categories (Sensitive Info / Location / Identifiers / Health)
  // are flagged beside the app count via a small muted chip that picks up colour on hover.
  const isSensitive = (category.riskWeight ?? 0) >= 5;

  return (
    <div
      className={`pmap-card ${expanded ? "is-expanded" : ""} ${isTarget ? "pmap-card-target" : ""} ${pulsing ? "pmap-card-pulse" : ""}`}
      id={anchorId}
      ref={cardRef}
    >
      {/*
        Card header — used to be a `<button>` but it nested another
        `<button>` (InfoTooltip's trigger) inside, which is invalid HTML
        and produced a Next.js hydration error. Switching to a
        `role="button"` div sidesteps the nesting rule while keeping
        every behaviour the original button had:
          • click — `onClick` toggles expand
          • Enter / Space keys — explicit `onKeyDown` (native buttons
            handle these automatically; div+role doesn't, hence the
            handler below)
          • aria-expanded — same attribute on a different element
          • focusable — `tabIndex={0}` puts it in the tab order
        Visually unchanged because `.pmap-card-header` styling doesn't
        depend on the element being a `<button>`.
      */}
      <div
        aria-expanded={expanded}
        className="pmap-card-header"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          // Mirror the native <button> keyboard contract: Enter and
          // Space both activate. preventDefault on Space stops the
          // page from scrolling alongside our toggle.
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        role="button"
        tabIndex={0}
      >
        <span aria-hidden="true" className="pmap-card-icon">
          {icon}
        </span>

        <span className="pmap-card-title-block">
          <span className="pmap-card-title-row">
            <span className="pmap-card-title">{label}</span>
            {meta?.description && (
              <span
                className="pmap-card-info"
                onClick={(e) => e.stopPropagation()}
              >
                <InfoTooltip text={meta.description} />
              </span>
            )}
          </span>
          <span className="pmap-card-subtitle">
            {category.apps.length} app{category.apps.length === 1 ? "" : "s"}
            {isSensitive && (
              <span
                className="pmap-card-sensitive-chip"
                title={tMap("sensitive_category_title")}
              >
                sensitive
              </span>
            )}
          </span>
        </span>

        <span aria-hidden="true" className="pmap-card-chevron">
          <svg
            aria-hidden="true"
            fill="none"
            height="12"
            viewBox="0 0 12 12"
            width="12"
          >
            <path
              d="M2.5 4.25L6 7.75L9.5 4.25"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.6"
            />
          </svg>
        </span>
      </div>

      {!expanded && category.apps.length > 0 && (
        /* Preview is a secondary affordance to expand the category. The
           primary control is still the header button above, so give this
           an aria-label that makes its purpose unambiguous and keyboard
           users can reach it via Tab. */
        <button
          aria-label={`Show all ${category.apps.length} app${category.apps.length === 1 ? "" : "s"} in ${label}`}
          className="pmap-card-preview"
          onClick={() => setExpanded(true)}
          type="button"
        >
          <div aria-hidden="true" className="pmap-preview-stack">
            {shown.map((app, i) => (
              <AppMiniIcon app={app} index={i} key={app.id} />
            ))}
            {extra > 0 && (
              <div
                className="pmap-preview-stack-item pmap-preview-more"
                style={{ zIndex: 10 }}
              >
                +{extra}
              </div>
            )}
          </div>
          <span className="pmap-preview-hint">{tMap("preview_hint_tap")}</span>
        </button>
      )}

      {expanded && (
        <div className="pmap-card-apps">
          {category.apps.map((app) => (
            <Link
              className="pmap-app-row"
              href={`/apps/${app.id}`}
              key={app.id}
            >
              {app.iconUrl ? (
                <Image
                  alt=""
                  className="pmap-app-icon"
                  height={32}
                  src={app.iconUrl}
                  style={{ objectFit: "cover" }}
                  unoptimized
                  width={32}
                />
              ) : (
                <div className="pmap-app-icon pmap-app-icon-placeholder">
                  {app.name[0]}
                </div>
              )}
              <span className="pmap-app-name">{app.name}</span>
              <span aria-hidden="true" className="pmap-app-arrow">
                →
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function AppMiniIcon({ app, index }: { app: AppRef; index: number }) {
  return (
    <div
      className="pmap-preview-stack-item"
      style={{ zIndex: 5 - index }}
      title={app.name}
    >
      {app.iconUrl ? (
        <Image
          alt={app.name}
          height={28}
          src={app.iconUrl}
          style={{ borderRadius: 6, objectFit: "cover" }}
          unoptimized
          width={28}
        />
      ) : (
        <span className="pmap-preview-initial">{app.name[0]}</span>
      )}
    </div>
  );
}
