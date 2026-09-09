// next-intl v4 plugin — registers the per-request server config at `./i18n.ts`.
const createNextIntlPlugin = require("next-intl/plugin");
const withNextIntl = createNextIntlPlugin("./i18n.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow LAN access to the dev server (HMR + RSC) when the developer
  // opens `http://<host-ip>:3000` from a phone, second machine, or the
  // Tauri webview (which uses 127.0.0.1 but can be configured to bind
  // elsewhere). Next 16 blocks non-localhost dev-resource fetches by
  // default. Wildcard the standard RFC1918 ranges — dev-only, no effect
  // on production builds. Add specific hostnames here if you serve dev
  // over a custom domain.
  allowedDevOrigins: [
    "192.168.*.*",
    "10.*.*.*",
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
    "*.local",
  ],
  // Pin the file-tracing / Turbopack root to this directory. Without it Next
  // walks up looking for lockfiles and, inside a git worktree nested under
  // the main clone's `.claude/worktrees/<name>/`, picks the PARENT clone's
  // pnpm-workspace.yaml instead. That warns on every build and breaks
  // `pnpm build:standalone`: server.js lands at
  // `.next/standalone/.claude/worktrees/<name>/server.js`, where
  // scripts/stage-standalone.mjs can't find it. In the main clone, CI and
  // Docker (`/app`) this resolves to exactly the root Next would infer.
  // biome-ignore lint/correctness/noGlobalDirnameFilename: this file is CommonJS (require/module.exports), so import.meta.dirname is unavailable.
  outputFileTracingRoot: __dirname,
  // Allow redirecting the build output dir for sandboxed / FUSE-mounted envs
  // where the default `.next` can't be unlinked.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Emit a self-contained `.next/standalone/` tree only when building for
  // the Tauri desktop sidecar. Next 16 doesn't support `next start` alongside
  // `output: 'standalone'`, so the Docker / web path keeps the default output
  // and `npm run build:standalone` flips this flag via `BUILD_STANDALONE=1`.
  ...(process.env.BUILD_STANDALONE ? { output: "standalone" } : {}),
  // better-sqlite3 is a native binding; Next must not bundle it.
  serverExternalPackages: ["better-sqlite3"],
  // The raw HTTP guard bounds each endpoint before Proxy buffers its body.
  // Allow legitimate backup uploads beyond Next's default 10 MiB clone limit.
  experimental: {
    proxyClientMaxBodySize: "100mb",
    // TypeScript 7 is a native compiler without the old JavaScript API.
    // Keep build-time type checking enabled through Next's CLI backend.
    useTypeScriptCli: true,
  },
  // Dev-only indicator — bottom-right anchor matches the CSS stacking rule
  // in app/globals.css. Production builds don't render this.
  devIndicators: {
    position: "bottom-right",
  },
  // Lock next/image to Apple's CDN hostnames. The five explicit
  // `is{1..5}-ssl.mzstatic.com` entries cover every host the App Store
  // currently serves icons from; no wildcard fallback so an attacker who
  // discovers a future `evil.mzstatic.com` subdomain can't pipe arbitrary
  // bytes through /_next/image.
  //
  // `unoptimized: true` short-circuits the /_next/image endpoint and
  // serves originals straight from the configured remote patterns. The
  // optimiser relies on `sharp`, which ships unsigned platform-specific
  // .node + libvips .dylib binaries — those get rejected by Apple's
  // notarytool when Tauri tars them into the desktop release's
  // standalone.tar (notarytool recurses into archives in
  // Contents/Resources). Optimisation buys almost nothing for our
  // workload anyway: App Store icons are already 100x100 / ~3 KB and
  // every request rides loopback. <Image> still gives us layout, lazy-
  // loading, and blur placeholders without the native dep.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "is1-ssl.mzstatic.com" },
      { protocol: "https", hostname: "is2-ssl.mzstatic.com" },
      { protocol: "https", hostname: "is3-ssl.mzstatic.com" },
      { protocol: "https", hostname: "is4-ssl.mzstatic.com" },
      { protocol: "https", hostname: "is5-ssl.mzstatic.com" },
    ],
    // Don't emit SVGs through the optimiser — SVG can carry script payloads.
    dangerouslyAllowSVG: false,
    unoptimized: true,
  },
  // Defence-in-depth headers — also cover static asset responses that
  // proxy.ts's matcher excludes (`_next/static`, `_next/image`, fonts).
  // The CSP itself stays in proxy.ts because it needs a per-request
  // nonce; the headers below are static and safe to apply universally.
  // Rust-core Phase 0 (layout batch): the two per-id detail pages are
  // client shells that read their id from the URL, so they render from
  // ONE static HTML each. `/apps/<id>` is rewritten internally to the
  // static `/apps/view` shell (browser URL unchanged; deep links from
  // notifications/bookmarks keep working). With every route static, the
  // build can hash each page's inline scripts for the CSP — a dynamic
  // [id] segment would have had per-request flight payloads no hash can
  // cover. The Rust server will do the same as an SPA-style fallback.
  async rewrites() {
    return {
      afterFiles: [
        { source: "/apps/:id", destination: "/apps/view" },
        { source: "/manual-apps/:id", destination: "/manual-apps/view" },
      ],
    };
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

module.exports = withNextIntl(nextConfig);
