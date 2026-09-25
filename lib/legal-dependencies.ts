/**
 * The data behind /legal: every npm package the app ships, the files it
 * bundles from outside npm, and the licences they come under.
 *
 * Runtime dependencies are DERIVED from package.json `dependencies`, so a
 * new one cannot be left off the page: `runtimeDependencyEntries()` throws
 * (failing the build that prerenders /legal) when a dependency has no notes
 * here, and `tests/app/legal-dependencies.test.ts` fails first, naming it.
 * The same test checks each licence below against the `license` field of
 * the installed package's own package.json.
 *
 * What stays hand-written is only what package.json cannot say: a one-line
 * description, how privacytracker uses the package, and links.
 *
 * Pure data and pure functions (no React, no database), so the client page
 * (app/components/content/LegalContent.tsx) and the unit test share it.
 */

import pkg from "../package.json";

/**
 * Licence identifiers the page groups by. Dual licences are their own group;
 * `normaliseLicenseExpression` treats "Apache-2.0 OR MIT" and
 * "(MIT OR Apache-2.0)" as the same choice when checking a package.
 */
export type SpdxLicense =
  | "MIT"
  | "Apache-2.0"
  | "BSD-3-Clause"
  | "ISC"
  | "MPL-2.0"
  | "MIT OR Apache-2.0"
  | "MPL-2.0 OR Apache-2.0"
  | "OFL-1.1"
  // OpenDyslexic v1 carries this licence (it's a Bitstream Vera
  // derivative). Not a standard SPDX ID (Bitstream's permission text
  // pre-dates SPDX), so we tag it 'Bitstream-Vera' and render it
  // explicitly like the other groups.
  | "Bitstream-Vera";

export interface LicenseMeta {
  /**
   * For a dual licence: the licences a user may choose between. The page
   * links each one's own text instead of a single "full licence" link.
   */
  anyOf?: SpdxLicense[];
  blurb: string;
  id: SpdxLicense;
  name: string;
  url: string;
}

export const LICENSE_META: Record<SpdxLicense, LicenseMeta> = {
  MIT: {
    id: "MIT",
    name: "MIT License",
    blurb:
      "Permissive licence: use, modify, distribute, and sublicense freely, provided the original copyright and licence notice is preserved. No warranty.",
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
      'Permissive licence with a "no endorsement" clause: the original author’s name cannot be used to promote derivatives without permission. Preserve the copyright notice and disclaimer.',
    url: "https://opensource.org/license/bsd-3-clause",
  },
  ISC: {
    id: "ISC",
    name: "ISC License",
    blurb:
      "Functionally equivalent to MIT but shorter. Permissive, attribution required, no warranty.",
    url: "https://opensource.org/license/isc-license-txt",
  },
  "MPL-2.0": {
    id: "MPL-2.0",
    name: "Mozilla Public License 2.0",
    blurb:
      "File-level copyleft: changes to MPL-licensed files must be shared under the MPL, while the larger work that uses them can carry any licence.",
    url: "https://www.mozilla.org/en-US/MPL/2.0/",
  },
  "MIT OR Apache-2.0": {
    id: "MIT OR Apache-2.0",
    name: "MIT License or Apache License 2.0",
    anyOf: ["MIT", "Apache-2.0"],
    blurb:
      "Dual-licensed: anyone may use these packages under either the MIT License or the Apache License 2.0. Both are permissive; the Apache licence adds an explicit patent grant.",
    url: "https://opensource.org/license/mit",
  },
  "MPL-2.0 OR Apache-2.0": {
    id: "MPL-2.0 OR Apache-2.0",
    name: "Mozilla Public License 2.0 or Apache License 2.0",
    anyOf: ["MPL-2.0", "Apache-2.0"],
    blurb:
      "Dual-licensed: anyone may use this package under either the Mozilla Public License 2.0 or the Apache License 2.0.",
    url: "https://www.mozilla.org/en-US/MPL/2.0/",
  },
  "OFL-1.1": {
    id: "OFL-1.1",
    name: "SIL Open Font License 1.1",
    blurb:
      "Permissive font licence. You may use, study, modify, and redistribute the font, including bundled in commercial products, provided the font itself is not sold on its own and the licence and reserved-font-name notice travel with it.",
    url: "https://openfontlicense.org/open-font-license-official-text/",
  },
  "Bitstream-Vera": {
    id: "Bitstream-Vera",
    name: "Bitstream Vera Fonts License",
    blurb:
      'Permissive font licence. You may copy, merge, distribute, and modify the font, including bundling it in commercial software, provided the licence notice travels with every copy, the font is not sold on its own, and any modifications drop the "Bitstream" and "Vera" reserved names. Used here for OpenDyslexic v1, which is derived from Bitstream Vera Sans.',
    url: "https://spdx.org/licenses/Bitstream-Vera.html",
  },
};

/**
 * Order the licence groups appear in, top to bottom. MIT first because it
 * is the biggest bucket. A licence missing from this list would not render
 * at all, which the unit test guards against.
 */
export const LICENSE_ORDER: SpdxLicense[] = [
  "MIT",
  "Apache-2.0",
  "MIT OR Apache-2.0",
  "MPL-2.0 OR Apache-2.0",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "OFL-1.1",
  "Bitstream-Vera",
];

export interface DependencyLinks {
  docs?: string;
  npm?: string;
  /** If the upstream publishes its own privacy policy. */
  privacy?: string;
  repo?: string;
  website?: string;
}

/** The hand-written part of an entry: what package.json cannot tell us. */
export interface DependencyNotes {
  /** One-liner explaining what the library actually is. */
  about: string;
  license: SpdxLicense;
  /** Links out. Omit any that don't apply. */
  links: DependencyLinks;
  /** How privacytracker uses it: concrete, not marketing. */
  usage: string;
}

export interface DependencyEntry extends DependencyNotes {
  /** `true` when the dep only ships with a local dev build, not production. */
  devOnly?: boolean;
  name: string;
  version: string;
}

const DEPENDENCIES = pkg.dependencies as Record<string, string>;
const DEV_DEPENDENCIES = pkg.devDependencies as Record<string, string>;

/**
 * Pull a dep's version straight from package.json at build time.
 *
 *   pkgVersion('next')             // -> "16.3.4"
 *   pkgVersion('echarts')          // -> "6.1.0"  (strips leading ^)
 *
 * Bump a package and the page shows the new version on the next build, no
 * second edit needed. Throws if the name is not in package.json: we'd
 * rather fail the build than render "undefined" on a legal disclosure.
 */
export function pkgVersion(name: string): string {
  const raw = DEPENDENCIES[name] ?? DEV_DEPENDENCIES[name];
  if (!raw) {
    throw new Error(
      `pkgVersion: "${name}" is not listed in package.json (dependencies or devDependencies).`
    );
  }
  // Strip the standard semver range prefixes (^, ~, >=, etc.) so the
  // page shows a concrete version string rather than a dep-spec range.
  return raw.replace(/^[\^~>=<\s]+/, "");
}

/**
 * Canonical form of an SPDX expression for comparison: no outer
 * parentheses, OR operands sorted alphabetically. Enough for the flat
 * "A OR B" expressions npm packages use here; anything with AND or
 * nesting is returned trimmed and compared as written.
 */
export function normaliseLicenseExpression(expression: string): string {
  const flat = expression.trim().replace(/^\((.*)\)$/, "$1");
  if (/\bAND\b|[()]/.test(flat)) {
    return flat;
  }
  return flat
    .split(/\s+OR\s+/)
    .map((part) => part.trim())
    .sort()
    .join(" OR ");
}

/**
 * Notes for every runtime dependency, keyed by package name. Every key of
 * package.json `dependencies` needs an entry here. Licences are copied from
 * each package's own package.json `license` field (the test re-reads it).
 */
export const RUNTIME_DEPENDENCY_NOTES: Record<string, DependencyNotes> = {
  "@dnd-kit/core": {
    license: "MIT",
    about:
      "Lightweight toolkit for accessible drag and drop in React: sensors, collision detection and screen-reader announcements.",
    usage:
      "Drag-to-reorder in the dashboard layout editor, both when editing the dashboard in place and on the list at /dashboard/settings/layout, including dragging with the keyboard (Space to pick up, arrow keys to move).",
    links: {
      website: "https://dndkit.com",
      repo: "https://github.com/clauderic/dnd-kit",
      npm: "https://www.npmjs.com/package/@dnd-kit/core",
    },
  },
  "@dnd-kit/sortable": {
    license: "MIT",
    about:
      "Sortable-list preset for dnd kit: ordering strategies and the useSortable hook.",
    usage:
      "Makes the dashboard cards and the layout editor's rows a sortable list and works out the new order after a drop.",
    links: {
      website: "https://dndkit.com",
      repo: "https://github.com/clauderic/dnd-kit",
      npm: "https://www.npmjs.com/package/@dnd-kit/sortable",
    },
  },
  "@dnd-kit/utilities": {
    license: "MIT",
    about: "Small helpers shared by the dnd kit packages.",
    usage:
      "Turns a card's drag position into a CSS transform while it is being moved.",
    links: {
      repo: "https://github.com/clauderic/dnd-kit",
      npm: "https://www.npmjs.com/package/@dnd-kit/utilities",
    },
  },
  "@tauri-apps/api": {
    license: "MIT OR Apache-2.0",
    about:
      "JavaScript bindings for the Tauri desktop runtime: native commands, events and window APIs.",
    usage:
      "Desktop app only. Lets the interface call the app's native commands (Dock icon, opening the data or log folder, the global shortcut) and hear native events such as a device being connected. A browser never makes these calls.",
    links: {
      website: "https://tauri.app",
      repo: "https://github.com/tauri-apps/tauri",
      npm: "https://www.npmjs.com/package/@tauri-apps/api",
    },
  },
  "@tauri-apps/plugin-process": {
    license: "MIT OR Apache-2.0",
    about: "Tauri plugin for exiting or restarting the running app.",
    usage:
      "Desktop app only. Restarts privacytracker after an update has been installed.",
    links: {
      website: "https://tauri.app",
      repo: "https://github.com/tauri-apps/plugins-workspace",
      npm: "https://www.npmjs.com/package/@tauri-apps/plugin-process",
    },
  },
  "@tauri-apps/plugin-updater": {
    license: "MIT OR Apache-2.0",
    about:
      "Tauri plugin that checks for, downloads and installs signed app updates.",
    usage:
      "Desktop app only. Runs when you press Install & restart on the update banner: it fetches the update manifest from GitHub, checks the update's signature and installs it.",
    links: {
      website: "https://tauri.app",
      repo: "https://github.com/tauri-apps/plugins-workspace",
      npm: "https://www.npmjs.com/package/@tauri-apps/plugin-updater",
    },
  },
  "@tesseract.js-data/eng": {
    license: "MIT",
    about:
      "Tesseract's English recognition model, the integer build of tesseract-ocr/tessdata_best that tesseract.js uses by default. The model itself is Apache-2.0; the npm package that carries it declares the MIT licence.",
    usage:
      "Served from /ocr/eng.traineddata.gz so screenshot import can read English app names offline. Your browser keeps a copy in this site's own storage so the next scan starts faster.",
    links: {
      repo: "https://github.com/naptha/tessdata",
      npm: "https://www.npmjs.com/package/@tesseract.js-data/eng",
    },
  },
  "better-sqlite3": {
    license: "MIT",
    about:
      "Synchronous, zero-config SQLite binding for Node, built against N-API.",
    usage:
      "The Node server's persistence layer. The singleton database in lib/db.ts runs on it: apps, privacy_types, privacy_categories, privacy_snapshots, notifications, app_settings and the rest. We set journal_mode=WAL, busy_timeout=5000 and foreign_keys=ON on open. The Rust backend uses its own SQLite binding, listed under Rust crates.",
    links: {
      repo: "https://github.com/WiseLibs/better-sqlite3",
      npm: "https://www.npmjs.com/package/better-sqlite3",
      docs: "https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md",
    },
  },
  dompurify: {
    license: "MPL-2.0 OR Apache-2.0",
    about:
      "HTML sanitiser from Cure53 that removes scripts and other dangerous markup, using the browser's own DOM.",
    usage:
      "Cleans the HTML made from your annotation notes before it is shown, so a note can never run script in the page.",
    links: {
      repo: "https://github.com/cure53/DOMPurify",
      npm: "https://www.npmjs.com/package/dompurify",
    },
  },
  echarts: {
    license: "Apache-2.0",
    about:
      "Apache ECharts: interactive charting library originally from Baidu, now an Apache top-level project.",
    usage:
      "Powers the data-viz panels: privacy heatmap, category frequency bars, stacked area timeline, per-app severity strips, and the small multiples on /dashboard/stats.",
    links: {
      website: "https://echarts.apache.org",
      repo: "https://github.com/apache/echarts",
      npm: "https://www.npmjs.com/package/echarts",
      docs: "https://echarts.apache.org/en/option.html",
    },
  },
  marked: {
    license: "MIT",
    about: "Fast Markdown parser and compiler.",
    usage:
      "Turns the Markdown you write in annotation notes into HTML, which DOMPurify then sanitises.",
    links: {
      website: "https://marked.js.org",
      repo: "https://github.com/markedjs/marked",
      npm: "https://www.npmjs.com/package/marked",
    },
  },
  next: {
    license: "MIT",
    about:
      "React framework from Vercel: file-system routing, server components, API routes, dev server and production build pipeline.",
    usage:
      "The interface is a Next.js App Router project. Every page, the Node server's /api/ routes, the background scheduler bootstrap (instrumentation.ts) and the build toolchain come from Next. The Rust backend serves the same pages from Next's static build.",
    links: {
      website: "https://nextjs.org",
      repo: "https://github.com/vercel/next.js",
      npm: "https://www.npmjs.com/package/next",
      docs: "https://nextjs.org/docs",
      privacy: "https://vercel.com/legal/privacy-policy",
    },
  },
  "next-intl": {
    license: "MIT",
    about:
      "Internationalisation for Next.js: message lookup, ICU plurals, and date and number formatting.",
    usage:
      "Every translated string in the interface is looked up through it from the locales/*.json message files, along with plural forms and localised dates.",
    links: {
      website: "https://next-intl.dev",
      repo: "https://github.com/amannn/next-intl",
      npm: "https://www.npmjs.com/package/next-intl",
    },
  },
  react: {
    license: "MIT",
    about: "Core React library: component model, hooks, reconciler primitives.",
    usage:
      "Powers every interactive surface: the onboarding wizard, Settings, the app detail page, the notification bell and the task centre, through hooks such as useState, useEffect, useMemo and useRef.",
    links: {
      website: "https://react.dev",
      repo: "https://github.com/facebook/react",
      npm: "https://www.npmjs.com/package/react",
    },
  },
  "react-dom": {
    license: "MIT",
    about: "React’s DOM renderer and hydration entry points.",
    usage:
      "Pairs with react to mount components into the browser page and to prerender each page's HTML at build time.",
    links: {
      repo: "https://github.com/facebook/react",
      npm: "https://www.npmjs.com/package/react-dom",
    },
  },
  "server-only": {
    license: "MIT",
    about:
      "Marker package from the React team. It has no code of its own that runs in the app.",
    usage:
      "Imported by modules that must only run on the server (database and device helpers), so the build fails if one of them is ever pulled into code sent to the browser.",
    links: {
      npm: "https://www.npmjs.com/package/server-only",
    },
  },
  "tesseract.js": {
    license: "Apache-2.0",
    about:
      "WebAssembly port of the Tesseract OCR engine. Runs entirely in the browser or in Node.",
    usage:
      "Optional, local-only OCR. Used in onboarding when you import screenshots of your iPhone's apps: Tesseract reads the visible app names so they can be looked up on the App Store. Its worker script is served by the app itself from /ocr/, with its licence and the notices of the small libraries it bundles alongside. No image leaves your device, and nothing is fetched from a CDN.",
    links: {
      website: "https://tesseract.projectnaptha.com",
      repo: "https://github.com/naptha/tesseract.js",
      npm: "https://www.npmjs.com/package/tesseract.js",
    },
  },
  "tesseract.js-core": {
    license: "Apache-2.0",
    about:
      "The Tesseract OCR engine compiled to WebAssembly, together with the libraries it is built with: Leptonica (BSD-2-Clause), libjpeg from the Independent JPEG Group, libpng, libtiff, libwebp (BSD-3-Clause), giflib (MIT), zlib and openlibm, each under its own licence. This software is based in part on the work of the Independent JPEG Group.",
    usage:
      "The engine screenshot import runs inside a browser worker. Three builds ship in /ocr/ (plain, SIMD and relaxed SIMD) and tesseract.js loads the one your browser supports. THIRD-PARTY-OCR.md beside them lists each component and its licence.",
    links: {
      repo: "https://github.com/naptha/tesseract.js-core",
      npm: "https://www.npmjs.com/package/tesseract.js-core",
    },
  },
  undici: {
    license: "MIT",
    about:
      "HTTP/1.1 client written for Node.js, maintained by the Node.js project.",
    usage:
      "The Node server's outbound requests (App Store, privacy policies, the Internet Archive, AI providers, webhooks) go through an undici dispatcher that checks every DNS answer and refuses private and cloud-metadata addresses, so a crafted link cannot reach your local network.",
    links: {
      website: "https://undici.nodejs.org",
      repo: "https://github.com/nodejs/undici",
      npm: "https://www.npmjs.com/package/undici",
    },
  },
};

/** Runtime dependencies without notes. Empty when the page is complete. */
export function runtimeDependenciesMissingNotes(): string[] {
  return Object.keys(DEPENDENCIES).filter(
    (name) => !Object.hasOwn(RUNTIME_DEPENDENCY_NOTES, name)
  );
}

/**
 * One entry per package.json `dependencies` key, in package.json order,
 * with the version read from package.json. Throws when a dependency has no
 * notes, so an incomplete /legal page fails the build instead of shipping.
 */
export function runtimeDependencyEntries(): DependencyEntry[] {
  const missing = runtimeDependenciesMissingNotes();
  if (missing.length > 0) {
    throw new Error(
      `lib/legal-dependencies.ts: no /legal entry for runtime ${missing.length === 1 ? "dependency" : "dependencies"} ${missing.join(", ")}. Add ${missing.length === 1 ? "it" : "them"} to RUNTIME_DEPENDENCY_NOTES.`
    );
  }
  return Object.keys(DEPENDENCIES).map((name) => ({
    name,
    version: pkgVersion(name),
    ...RUNTIME_DEPENDENCY_NOTES[name],
  }));
}

/**
 * Files the app ships that do not come from npm, so package.json has no
 * version for them and the version is written by hand. Add new bundled
 * assets (fonts, OCR data and the like) here.
 */
export const BUNDLED_ASSETS: DependencyEntry[] = [
  {
    name: "Inter typeface",
    // Bump when the woff2 files in public/fonts/ are refreshed.
    version: "4.1",
    license: "OFL-1.1",
    about:
      "Sans-serif typeface designed for UI by Rasmus Andersson. Variable-font release shipping upright and italic axes across weights 100–900.",
    usage:
      "Primary UI typeface. Shipped as two woff2 files in /public/fonts/ (InterVariable.woff2 and InterVariable-Italic.woff2) with the project’s licence text alongside them, and declared via @font-face in app/globals.css. Served from the same origin as the app, with no Google Fonts round-trip.",
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
      'Optional accessibility font. Activated via the footer accessibility quick-toggles (Dyslexia-friendly font), which set data-a11y-font="dyslexic" on <html>. Shipped as two woff files in /public/fonts/ (OpenDyslexic-Regular.woff and OpenDyslexic-Bold.woff) with the full Bitstream Vera licence alongside them (OpenDyslexic-LICENSE.txt), and declared via @font-face in app/globals.css. Served from the same origin as the app, with no third-party CDN round-trip, so it works offline and in the desktop app.',
    links: {
      website: "https://opendyslexic.org",
      repo: "https://github.com/antijingoist/opendyslexic",
      npm: "https://www.npmjs.com/package/open-dyslexic",
    },
  },
];

/**
 * A curated selection of build tools. They are not shipped to users, so
 * unlike the runtime list this one is not required to be complete; each
 * entry must still name a real devDependency with its real licence (the
 * unit test checks both).
 */
export const DEV_DEPENDENCY_NOTES: Record<string, DependencyNotes> = {
  typescript: {
    license: "Apache-2.0",
    about: "Typed superset of JavaScript from Microsoft; compiles to JS.",
    usage:
      "Every source file under app/ and lib/ is TypeScript. The compiler runs at build time only and isn’t shipped to users.",
    links: {
      website: "https://www.typescriptlang.org",
      repo: "https://github.com/microsoft/TypeScript",
      npm: "https://www.npmjs.com/package/typescript",
    },
  },
  "@tauri-apps/cli": {
    license: "MIT OR Apache-2.0",
    about:
      "Command-line tool for building Tauri desktop apps (Rust-backed webview wrappers).",
    usage:
      "Builds the desktop app (pnpm tauri:build). Not shipped to users of the web build.",
    links: {
      website: "https://tauri.app",
      repo: "https://github.com/tauri-apps/tauri",
      npm: "https://www.npmjs.com/package/@tauri-apps/cli",
    },
  },
  "@types/better-sqlite3": {
    license: "MIT",
    about:
      "TypeScript type definitions for better-sqlite3, maintained by the DefinitelyTyped community.",
    usage:
      "Dev-time only: autocomplete and type checking for the database binding. Not shipped.",
    links: {
      repo: "https://github.com/DefinitelyTyped/DefinitelyTyped",
      npm: "https://www.npmjs.com/package/@types/better-sqlite3",
    },
  },
  "@types/node": {
    license: "MIT",
    about: "TypeScript type definitions for the Node.js standard library.",
    usage:
      "Dev-time only: types for built-in modules (fs, path, crypto and so on). Not shipped.",
    links: {
      repo: "https://github.com/DefinitelyTyped/DefinitelyTyped",
      npm: "https://www.npmjs.com/package/@types/node",
    },
  },
  "@types/react": {
    license: "MIT",
    about: "TypeScript type definitions for React.",
    usage: "Dev-time only: types for the React component API. Not shipped.",
    links: {
      repo: "https://github.com/DefinitelyTyped/DefinitelyTyped",
      npm: "https://www.npmjs.com/package/@types/react",
    },
  },
  "@types/react-dom": {
    license: "MIT",
    about: "TypeScript type definitions for react-dom.",
    usage: "Dev-time only: types for the DOM renderer API. Not shipped.",
    links: {
      repo: "https://github.com/DefinitelyTyped/DefinitelyTyped",
      npm: "https://www.npmjs.com/package/@types/react-dom",
    },
  },
  "cross-env": {
    license: "MIT",
    about:
      "Tiny shim that sets environment variables the same way across Unix and Windows shells.",
    usage:
      "Used in the build:standalone script to set BUILD_STANDALONE=1 before running next build, so the same command works on macOS, Linux and Windows.",
    links: {
      repo: "https://github.com/kentcdodds/cross-env",
      npm: "https://www.npmjs.com/package/cross-env",
    },
  },
};

export function devDependencyEntries(): DependencyEntry[] {
  return Object.entries(DEV_DEPENDENCY_NOTES).map(([name, notes]) => ({
    name,
    version: pkgVersion(name),
    devOnly: true,
    ...notes,
  }));
}

/** Everything /legal lists, in display order within each licence group. */
export function legalDependencies(): DependencyEntry[] {
  return [
    ...runtimeDependencyEntries(),
    ...BUNDLED_ASSETS,
    ...devDependencyEntries(),
  ];
}
