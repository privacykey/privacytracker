import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";
import pkg from "../../package.json";

export const dynamic = "force-dynamic";

/**
 * Pull a dep's version straight from package.json at build time.
 *
 *   pkgVersion('next')             // -> "16.2.4"
 *   pkgVersion('echarts')          // -> "5.5.1"  (strips leading ^)
 *   pkgVersion('@types/react')     // -> "19.2.3"
 *
 * When the maintainer bumps a package with `npm install foo@latest`,
 * package.json changes, Next re-compiles /legal on the next build, and
 * this page shows the new version automatically — no second edit needed.
 * Anything that is NOT in package.json (Inter, which ships as a binary
 * woff2, or anything else bundled outside npm) still uses a hard-coded
 * string on the entry.
 *
 * Throws at build time if an entry points at a missing dep — we'd rather
 * fail the build than render "undefined" on a legal disclosure.
 */
function pkgVersion(name: string): string {
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  } as Record<string, string>;
  const raw = deps[name];
  if (!raw) {
    throw new Error(
      `pkgVersion: "${name}" is not listed in package.json (dependencies or devDependencies).`
    );
  }
  // Strip the standard semver range prefixes (^, ~, >=, etc.) so the
  // page shows a concrete version string rather than a dep-spec range.
  return raw.replace(/^[\^~>=<\s]+/, "");
}

export const metadata: Metadata = {
  title: "Legal — Open-source libraries & licences",
  description:
    "Third-party libraries bundled with privacytracker, their versions, licences, and what each one is used for. Grouped by licence identifier with a sticky sidebar.",
};

/**
 * /legal — attribution + licence disclosure page. Lists every third-party
 * library bundled with the app, grouped by SPDX licence identifier.
 *
 * Server component by default so it works without JavaScript. The sticky
 * sidebar is pure CSS / anchor links — no JS required to navigate.
 *
 * Versions are read straight from package.json so they can drift without
 * this page going stale. If a dep is added or removed upstream, update
 * the `DEPENDENCIES` constant below — we deliberately don't auto-generate
 * from node_modules because the disclosures (what it does, how we use
 * it, links out) are curated per-library.
 */

interface DependencyEntry {
  /** One-liner explaining what the library actually is. */
  about: string;
  /** `true` when the dep only ships with a local dev build, not production. */
  devOnly?: boolean;
  license: SpdxLicense;
  /** Links out. Omit any that don't apply. */
  links: {
    website?: string;
    repo?: string;
    npm?: string;
    docs?: string;
    /** If the upstream publishes their own privacy policy. */
    privacy?: string;
  };
  name: string;
  /** How privacytracker uses it — concrete, not marketing. */
  usage: string;
  version: string;
}

type SpdxLicense =
  | "MIT"
  | "Apache-2.0"
  | "BSD-3-Clause"
  | "ISC"
  | "OFL-1.1"
  // OpenDyslexic v1 carries this licence (it's a Bitstream Vera
  // derivative). Not a standard SPDX ID — Bitstream's permission text
  // pre-dates SPDX — so we tag it 'Bitstream-Vera' and render it
  // explicitly like the other groups.
  | "Bitstream-Vera";

interface LicenseMeta {
  blurb: string;
  id: SpdxLicense;
  name: string;
  url: string;
}

const LICENSE_META: Record<SpdxLicense, LicenseMeta> = {
  MIT: {
    id: "MIT",
    name: "MIT License",
    blurb:
      "Permissive licence — use, modify, distribute, and sublicense freely, provided the original copyright + licence notice is preserved. No warranty.",
    url: "https://opensource.org/license/mit",
  },
  "Apache-2.0": {
    id: "Apache-2.0",
    name: "Apache License 2.0",
    blurb:
      "Permissive licence with an explicit patent grant and trademark notice. Preserve the licence text and attribution; mark any modified files as changed.",
    url: "https://www.apache.org/licenses/LICENSE-2.0",
  },
  "BSD-3-Clause": {
    id: "BSD-3-Clause",
    name: "BSD 3-Clause License",
    blurb:
      'Permissive licence with a "no endorsement" clause — cannot use the original author\u2019s name to promote derivatives without permission. Preserve the copyright notice and disclaimer.',
    url: "https://opensource.org/license/bsd-3-clause",
  },
  ISC: {
    id: "ISC",
    name: "ISC License",
    blurb:
      "Functionally equivalent to MIT but shorter. Permissive, attribution required, no warranty.",
    url: "https://opensource.org/license/isc-license-txt",
  },
  "OFL-1.1": {
    id: "OFL-1.1",
    name: "SIL Open Font License 1.1",
    blurb:
      "Permissive font licence. You may use, study, modify, and redistribute the font — including bundled in commercial products — provided the font itself is not sold on its own and the licence + reserved-font-name notice travel with it.",
    url: "https://openfontlicense.org/open-font-license-official-text/",
  },
  "Bitstream-Vera": {
    id: "Bitstream-Vera",
    name: "Bitstream Vera Fonts License",
    blurb:
      'Permissive font licence. You may copy, merge, distribute, and modify the font — including bundling it in commercial software — provided the licence notice travels with every copy, the font is not sold on its own, and any modifications drop the "Bitstream" / "Vera" reserved names. Used here for OpenDyslexic v1, which is derived from Bitstream Vera Sans.',
    url: "https://spdx.org/licenses/Bitstream-Vera.html",
  },
};

// Version strings are resolved at build time from package.json via
// pkgVersion() above, so this list doesn't go stale when dependencies
// are bumped — bump package.json and the page updates on the next build.
// The only exception is the "Inter typeface" entry, which isn't a runtime
// npm dep (it ships as woff2 files in /public/fonts/) so its version is
// still hard-coded.
const DEPENDENCIES: DependencyEntry[] = [
  // ── Runtime (production) ─────────────────────────────────────────────
  {
    name: "next",
    version: pkgVersion("next"),
    license: "MIT",
    about:
      "React framework from Vercel — file-system routing, server components, API routes, dev server, production build pipeline.",
    usage:
      "The entire app is a Next.js App Router project. Every page, every /api/ route, the background scheduler bootstrap (instrumentation.ts), and the build/serve toolchain come from Next.",
    links: {
      website: "https://nextjs.org",
      repo: "https://github.com/vercel/next.js",
      npm: "https://www.npmjs.com/package/next",
      docs: "https://nextjs.org/docs",
      privacy: "https://vercel.com/legal/privacy-policy",
    },
  },
  {
    name: "react",
    version: pkgVersion("react"),
    license: "MIT",
    about:
      "Core React library — component model, hooks, reconciler primitives.",
    usage:
      "Powers every interactive surface — the onboarding wizard, SettingsView, AppDetailView, the bell, the task centre. Provides the hooks (useState, useEffect, useMemo, useRef) the UI relies on.",
    links: {
      website: "https://react.dev",
      repo: "https://github.com/facebook/react",
      npm: "https://www.npmjs.com/package/react",
    },
  },
  {
    name: "react-dom",
    version: pkgVersion("react-dom"),
    license: "MIT",
    about: "React\u2019s DOM renderer + hydration entry points.",
    usage:
      "Pairs with react to actually mount components into the browser DOM and server-render pages for the initial HTML response.",
    links: {
      repo: "https://github.com/facebook/react",
      npm: "https://www.npmjs.com/package/react-dom",
    },
  },
  {
    name: "better-sqlite3",
    version: pkgVersion("better-sqlite3"),
    license: "MIT",
    about:
      "Synchronous, zero-config SQLite binding for Node — binary wheel built against N-API.",
    usage:
      "The entire persistence layer. The singleton DB in lib/db.ts runs on this — apps, privacy_types, privacy_categories, privacy_snapshots, notifications, app_settings, all of it. We set journal_mode=WAL, busy_timeout=5000, foreign_keys=ON on open.",
    links: {
      repo: "https://github.com/WiseLibs/better-sqlite3",
      npm: "https://www.npmjs.com/package/better-sqlite3",
      docs: "https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md",
    },
  },
  {
    name: "echarts",
    version: pkgVersion("echarts"),
    license: "Apache-2.0",
    about:
      "Apache ECharts — interactive charting library originally from Baidu, now an Apache top-level project.",
    usage:
      "Powers the data-viz panels: privacy heatmap, category frequency bars, stacked area timeline, per-app severity strips, the small multiples on /dashboard/stats.",
    links: {
      website: "https://echarts.apache.org",
      repo: "https://github.com/apache/echarts",
      npm: "https://www.npmjs.com/package/echarts",
      docs: "https://echarts.apache.org/en/option.html",
    },
  },
  {
    name: "tesseract.js",
    version: pkgVersion("tesseract.js"),
    license: "Apache-2.0",
    about:
      "WebAssembly port of the Tesseract OCR engine. Runs entirely in the browser or in Node.",
    usage:
      "Optional, local-only OCR. Used in onboarding when the user imports iOS app screenshots — Tesseract extracts the visible app names so we can look them up on the App Store. No image leaves your device.",
    links: {
      website: "https://tesseract.projectnaptha.com",
      repo: "https://github.com/naptha/tesseract.js",
      npm: "https://www.npmjs.com/package/tesseract.js",
    },
  },

  // ── Typeface ─────────────────────────────────────────────────────────
  {
    name: "Inter typeface",
    version: "4.1",
    license: "OFL-1.1",
    about:
      "Sans-serif typeface designed for UI by Rasmus Andersson. Variable-font release shipping upright + italic axes across weights 100\u2013900.",
    usage:
      "Primary UI typeface. Shipped as two woff2 files in /public/fonts/ (InterVariable.woff2 + InterVariable-Italic.woff2) with the project\u2019s LICENSE.txt alongside them, and declared via @font-face in app/globals.css. Served from the same origin as the app \u2014 no Google Fonts round-trip.",
    links: {
      website: "https://rsms.me/inter/",
      repo: "https://github.com/rsms/inter",
      npm: "https://www.npmjs.com/package/inter-ui",
    },
  },
  {
    name: "OpenDyslexic typeface",
    version: "1.0.3",
    license: "Bitstream-Vera",
    about:
      "Typeface with weighted letterforms designed to improve readability for some readers with dyslexia. Originally designed by Abelardo Gonzalez, derived from Bitstream Vera Sans.",
    usage:
      'Optional accessibility font. Activated via the footer accessibility quick-toggles (Dyslexia-friendly font) which sets data-a11y-font="dyslexic" on <html>. Shipped as two woff files in /public/fonts/ (OpenDyslexic-Regular.woff + OpenDyslexic-Bold.woff) with the full Bitstream Vera licence alongside them (OpenDyslexic-LICENSE.txt), and declared via @font-face in app/globals.css. Served from the same origin as the app \u2014 no third-party CDN round-trip, so the feature works offline and in the Tauri desktop build.',
    links: {
      website: "https://opendyslexic.org",
      repo: "https://github.com/antijingoist/opendyslexic",
      npm: "https://www.npmjs.com/package/open-dyslexic",
    },
  },

  // ── Dev dependencies ─────────────────────────────────────────────────
  {
    name: "typescript",
    version: pkgVersion("typescript"),
    license: "Apache-2.0",
    devOnly: true,
    about: "Typed superset of JavaScript from Microsoft; compiles to JS.",
    usage:
      "Every source file under app/ and lib/ is TypeScript. The compiler runs at build time only — it isn\u2019t shipped to users.",
    links: {
      website: "https://www.typescriptlang.org",
      repo: "https://github.com/microsoft/TypeScript",
      npm: "https://www.npmjs.com/package/typescript",
    },
  },
  {
    name: "@tauri-apps/cli",
    version: pkgVersion("@tauri-apps/cli"),
    license: "Apache-2.0",
    devOnly: true,
    about:
      "Command-line tool for building Tauri desktop apps (Rust-backed webview wrappers).",
    usage:
      "Optional desktop-build path. Used by npm run tauri:build to package the app as a native desktop binary. Not shipped to end-users of the web build.",
    links: {
      website: "https://tauri.app",
      repo: "https://github.com/tauri-apps/tauri",
      npm: "https://www.npmjs.com/package/@tauri-apps/cli",
    },
  },
  {
    name: "@types/better-sqlite3",
    version: pkgVersion("@types/better-sqlite3"),
    license: "MIT",
    devOnly: true,
    about:
      "TypeScript type definitions for better-sqlite3, maintained by the DefinitelyTyped community.",
    usage:
      "Dev-time only — provides autocomplete and type checking for the DB binding. Not shipped.",
    links: {
      repo: "https://github.com/DefinitelyTyped/DefinitelyTyped",
      npm: "https://www.npmjs.com/package/@types/better-sqlite3",
    },
  },
  {
    name: "@types/node",
    version: pkgVersion("@types/node"),
    license: "MIT",
    devOnly: true,
    about: "TypeScript type definitions for the Node.js standard library.",
    usage:
      "Dev-time only — provides types for built-in modules (fs, path, crypto, etc.). Not shipped.",
    links: {
      repo: "https://github.com/DefinitelyTyped/DefinitelyTyped",
      npm: "https://www.npmjs.com/package/@types/node",
    },
  },
  {
    name: "@types/react",
    version: pkgVersion("@types/react"),
    license: "MIT",
    devOnly: true,
    about: "TypeScript type definitions for React.",
    usage:
      "Dev-time only — provides types for the React component API. Not shipped.",
    links: {
      repo: "https://github.com/DefinitelyTyped/DefinitelyTyped",
      npm: "https://www.npmjs.com/package/@types/react",
    },
  },
  {
    name: "@types/react-dom",
    version: pkgVersion("@types/react-dom"),
    license: "MIT",
    devOnly: true,
    about: "TypeScript type definitions for react-dom.",
    usage:
      "Dev-time only — provides types for the DOM renderer API. Not shipped.",
    links: {
      repo: "https://github.com/DefinitelyTyped/DefinitelyTyped",
      npm: "https://www.npmjs.com/package/@types/react-dom",
    },
  },
  {
    name: "cross-env",
    version: pkgVersion("cross-env"),
    license: "MIT",
    devOnly: true,
    about:
      "Tiny shim that sets environment variables the same way across Unix and Windows shells.",
    usage:
      "Used in the build:standalone npm script to set BUILD_STANDALONE=1 before running next build, so the same command works on macOS, Linux, and Windows.",
    links: {
      repo: "https://github.com/kentcdodds/cross-env",
      npm: "https://www.npmjs.com/package/cross-env",
    },
  },
];

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

// Order in which licence groups appear top-to-bottom. We put MIT first
// because it's by far the biggest bucket; the others follow in a stable
// order so navigation lands in the same place every time.
const LICENSE_ORDER: SpdxLicense[] = [
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "ISC",
  "OFL-1.1",
  "Bitstream-Vera",
];

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

export default async function LegalPage() {
  // Round 3 PR 6.1: gate on `flag.legal.terms_page`. Default on; toggling
  // off in Dev Options 404s the route. Same caveat as /privacy-policy —
  // shipping a privacy auditor without the licensing disclosure is bad
  // form, but the flag exists for embedded / OEM builds.
  if (resolveFlagFromDb("flag.legal.terms_page") !== "on") {
    notFound();
  }

  // i18n — page chrome only (back link, eyebrow, title, subtitle, sidebar
  // aria + heading). The dependency table + per-licence prose stays
  // English in v1; full translation is tracked separately because it
  // requires careful handling of SPDX identifiers and dep descriptions.
  const t = await getTranslations("legal_page");

  // Wave I — `flag.legal.audit_bundle_note` toggles a paragraph on
  // /legal explaining what audit-bundle exports include + omit. Off by
  // default; flipping it on surfaces the disclosure for users testing
  // the export today.
  const showAuditBundleNote =
    resolveFlagFromDb("flag.legal.audit_bundle_note") === "on";

  const grouped = groupByLicense(DEPENDENCIES);
  const licenseGroups = LICENSE_ORDER.filter((id) => grouped[id]?.length);

  return (
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
        {showAuditBundleNote && (
          <p className="legal-page-sub" style={{ marginTop: 14 }}>
            {t.rich("audit_bundle_note", {
              strong: (chunks) => <strong>{chunks}</strong>,
              em: (chunks) => <em>{chunks}</em>,
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
        )}
      </header>

      <div className="legal-layout">
        <aside aria-label={t("sidebar_aria")} className="legal-sidebar">
          <p className="legal-sidebar-title">{t("sidebar_jump")}</p>
          <ul className="legal-sidebar-list">
            {licenseGroups.map((id) => (
              <li key={id}>
                <a className="legal-sidebar-link" href={`#${licenseSlug(id)}`}>
                  <span>{LICENSE_META[id].name}</span>
                  <span className="legal-sidebar-count">
                    {grouped[id].length}
                  </span>
                </a>
              </li>
            ))}
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
                    <a
                      href={meta.url}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      Full licence text ↗
                    </a>
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
        </div>
      </div>
    </div>
  );
}
