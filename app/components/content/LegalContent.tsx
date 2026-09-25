"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import FlagGated from "@/app/components/FlagGated";
import RequireFlagGate from "@/app/components/RequireFlagGate";
import {
  type DependencyEntry,
  LICENSE_META,
  LICENSE_ORDER,
  legalDependencies,
  type SpdxLicense,
} from "@/lib/legal-dependencies";
import rustCrates from "@/lib/rust-crates.json";

/**
 * /legal: attribution and licence disclosure page. Lists every third-party
 * library bundled with the app, grouped by SPDX licence identifier.
 *
 * The data lives in lib/legal-dependencies.ts. Runtime dependencies are
 * derived from package.json `dependencies` there, so a new dependency
 * without an entry fails the build (and its unit test) instead of being
 * left off this page. Versions are read from package.json at build time.
 *
 * The sticky sidebar is plain anchor links.
 */

// Resolved once per build (module scope runs at prerender). Throws when a
// runtime dependency has no entry, which fails the build on purpose.
const DEPENDENCIES: DependencyEntry[] = legalDependencies();

// Build-time group-by-licence. The output is deterministic across renders
// because the source array has a stable order, so the sticky sidebar
// anchor links never drift between SSR and hydration.
function groupByLicense(
  deps: DependencyEntry[]
): Record<SpdxLicense, DependencyEntry[]> {
  const out = {} as Record<SpdxLicense, DependencyEntry[]>;
  for (const d of deps) {
    (out[d.license] ??= []).push(d);
  }
  return out;
}

function licenseSlug(id: SpdxLicense): string {
  return `license-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function DepCard({ dep }: { dep: DependencyEntry }) {
  return (
    <article className="legal-dep-card">
      <header className="legal-dep-head">
        <h3 className="legal-dep-name">
          {dep.name}
          {dep.devOnly && (
            <span
              className="priv-nec-chip priv-nec-optional"
              style={{ marginLeft: 8 }}
            >
              dev-only
            </span>
          )}
        </h3>
        <span className="legal-dep-version">v{dep.version}</span>
      </header>
      <p className="legal-dep-use">
        <strong>How we use it:</strong> {dep.usage}
      </p>
      <p className="legal-dep-about">{dep.about}</p>
      <div className="legal-dep-links">
        {dep.links.website && (
          <a
            className="legal-dep-link"
            href={dep.links.website}
            rel="noopener noreferrer"
            target="_blank"
          >
            Website ↗
          </a>
        )}
        {dep.links.repo && (
          <a
            className="legal-dep-link"
            href={dep.links.repo}
            rel="noopener noreferrer"
            target="_blank"
          >
            Source ↗
          </a>
        )}
        {dep.links.npm && (
          <a
            className="legal-dep-link"
            href={dep.links.npm}
            rel="noopener noreferrer"
            target="_blank"
          >
            npm ↗
          </a>
        )}
        {dep.links.docs && (
          <a
            className="legal-dep-link"
            href={dep.links.docs}
            rel="noopener noreferrer"
            target="_blank"
          >
            Docs ↗
          </a>
        )}
        {dep.links.privacy && (
          <a
            className="legal-dep-link"
            href={dep.links.privacy}
            rel="noopener noreferrer"
            target="_blank"
          >
            Privacy policy ↗
          </a>
        )}
      </div>
    </article>
  );
}

/** The anchor the sidebar links to for the Rust section. */
const RUST_SECTION_ID = "rust-crates";

/**
 * The desktop app's other half. Everything above this is an npm package
 * read from package.json; the desktop build on the Rust backend links
 * compiled crates instead, which cargo knows about and package.json does
 * not. `lib/rust-crates.json` is generated from cargo's own dependency
 * graph (`pnpm notices:rust`, checked in CI), so this cannot drift from
 * what is built.
 *
 * The crates named here are the ones chosen directly. The complete list,
 * every transitive dependency included, ships inside the app at
 * `third-party/THIRD-PARTY-RUST.md` and is in the repository.
 *
 * The prose is translated like the rest of the page chrome; the rows are
 * not, because a crate name, a version and an SPDX identifier are the
 * upstream's own spelling and translating them would misquote a licence.
 */
function RustCrates() {
  const t = useTranslations("legal_page.rust_crates");
  const licences = Object.entries(rustCrates.licenses);
  return (
    <section
      aria-labelledby={`${RUST_SECTION_ID}-heading`}
      className="legal-license-group"
      id={RUST_SECTION_ID}
    >
      <header className="legal-license-head">
        <h2 className="legal-license-name" id={`${RUST_SECTION_ID}-heading`}>
          {t("heading")}
        </h2>
        <p className="legal-license-blurb">
          {t.rich("blurb", {
            code: (chunks) => <code>{chunks}</code>,
            crates: rustCrates.crates,
            direct: rustCrates.direct.length,
          })}{" "}
          <a
            href="https://github.com/privacykey/privacytracker/blob/main/src-tauri/THIRD-PARTY-RUST.md"
            rel="noopener noreferrer"
            target="_blank"
          >
            {t("full_list")}
          </a>
        </p>
        {/* Every declared licence, most common first, as the crates spell
            them: "MIT OR Apache-2.0" and "MIT/Apache-2.0" are the same
            choice written two ways, and rewriting either would be us
            paraphrasing someone else's licence. */}
        <p className="legal-license-blurb">
          {licences.map(([id, count]) => `${id} (${count})`).join(" · ")}
        </p>
      </header>
      <div className="legal-dep-list">
        {rustCrates.direct.map((crate) => (
          <article
            className="legal-dep-card"
            key={`${crate.name}@${crate.version}`}
          >
            <header className="legal-dep-head">
              <h3 className="legal-dep-name">{crate.name}</h3>
              <span className="legal-dep-version">{crate.version}</span>
              <span className="legal-dep-license">{crate.license}</span>
            </header>
            {crate.repository && (
              <div className="legal-dep-links">
                <a
                  className="legal-dep-link"
                  href={crate.repository}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Source ↗
                </a>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

export default function LegalContent() {
  // Round 3 PR 6.1: gate on `flag.legal.terms_page`. Default on; toggling
  // off in Dev Options 404s the route. Same caveat as /privacy-policy —
  // shipping a privacy auditor without the licensing disclosure is bad
  // form, but the flag exists for embedded / OEM builds.
  // i18n — page chrome only (back link, eyebrow, title, subtitle, sidebar
  // aria + heading). The dependency table + per-licence prose stays
  // English in v1; full translation is tracked separately because it
  // requires careful handling of SPDX identifiers and dep descriptions.
  const t = useTranslations("legal_page");

  const grouped = groupByLicense(DEPENDENCIES);
  const licenseGroups = LICENSE_ORDER.filter((id) => grouped[id]?.length);

  return (
    <RequireFlagGate flag="flag.legal.terms_page">
      <div className="legal-page">
        <header className="legal-page-hero">
          <Link className="priv-back-link" href="/">
            {t("back_to_app")}
          </Link>
          <p className="priv-eyebrow">{t("eyebrow")}</p>
          <h1 className="legal-page-title">{t("title")}</h1>
          <p className="legal-page-sub">
            {t.rich("subtitle", { code: (chunks) => <code>{chunks}</code> })}
          </p>
          {/* Wave I — `flag.legal.audit_bundle_note` toggles a paragraph
            explaining what audit-bundle exports include + omit. Off by
            default; flipping it on surfaces the disclosure. */}
          <FlagGated flag="flag.legal.audit_bundle_note">
            <p className="legal-page-sub" style={{ marginTop: 14 }}>
              {t.rich("audit_bundle_note", {
                strong: (chunks) => <strong>{chunks}</strong>,
                em: (chunks) => <em>{chunks}</em>,
                code: (chunks) => <code>{chunks}</code>,
              })}
            </p>
          </FlagGated>
        </header>

        <div className="legal-layout">
          <aside aria-label={t("sidebar_aria")} className="legal-sidebar">
            <p className="legal-sidebar-title">{t("sidebar_jump")}</p>
            <ul className="legal-sidebar-list">
              {licenseGroups.map((id) => (
                <li key={id}>
                  <a
                    className="legal-sidebar-link"
                    href={`#${licenseSlug(id)}`}
                  >
                    <span>{LICENSE_META[id].name}</span>
                    <span className="legal-sidebar-count">
                      {grouped[id].length}
                    </span>
                  </a>
                </li>
              ))}
              <li>
                <a className="legal-sidebar-link" href={`#${RUST_SECTION_ID}`}>
                  <span>{t("rust_crates.sidebar")}</span>
                  <span className="legal-sidebar-count">
                    {rustCrates.direct.length}
                  </span>
                </a>
              </li>
            </ul>
          </aside>

          <div className="legal-content">
            {licenseGroups.map((id) => {
              const meta = LICENSE_META[id];
              return (
                <section
                  aria-labelledby={`${licenseSlug(id)}-heading`}
                  className="legal-license-group"
                  id={licenseSlug(id)}
                  key={id}
                >
                  <header className="legal-license-head">
                    <h2
                      className="legal-license-name"
                      id={`${licenseSlug(id)}-heading`}
                    >
                      {meta.name}
                    </h2>
                    <p className="legal-license-blurb">
                      {meta.blurb}{" "}
                      {meta.anyOf ? (
                        // A dual licence links each licence's own text,
                        // named, rather than one ambiguous link.
                        meta.anyOf.map((choice, i) => (
                          <span key={choice}>
                            {i > 0 && " · "}
                            <a
                              href={LICENSE_META[choice].url}
                              rel="noopener noreferrer"
                              target="_blank"
                            >
                              {LICENSE_META[choice].name} ↗
                            </a>
                          </span>
                        ))
                      ) : (
                        <a
                          href={meta.url}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          Full licence text ↗
                        </a>
                      )}
                    </p>
                  </header>
                  <div className="legal-dep-list">
                    {grouped[id].map((dep) => (
                      <DepCard dep={dep} key={dep.name} />
                    ))}
                  </div>
                </section>
              );
            })}
            <RustCrates />
          </div>
        </div>
      </div>
    </RequireFlagGate>
  );
}
