// next-intl v4 plugin — registers the per-request server config at `./i18n.ts`.
const createNextIntlPlugin = require('next-intl/plugin');
const withNextIntl = createNextIntlPlugin('./i18n.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow redirecting the build output dir for sandboxed / FUSE-mounted envs
  // where the default `.next` can't be unlinked.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Emit a self-contained `.next/standalone/` tree only when building for
  // the Tauri desktop sidecar. Next 16 doesn't support `next start` alongside
  // `output: 'standalone'`, so the Docker / web path keeps the default output
  // and `npm run build:standalone` flips this flag via `BUILD_STANDALONE=1`.
  ...(process.env.BUILD_STANDALONE ? { output: 'standalone' } : {}),
  // better-sqlite3 is a native binding; Next must not bundle it.
  serverExternalPackages: ["better-sqlite3"],
  // Dev-only indicator — bottom-right anchor matches the CSS stacking rule
  // in app/globals.css. Production builds don't render this.
  devIndicators: {
    position: 'bottom-right',
  },
  // Lock next/image to Apple's CDN hostnames. Wildcard hostnames would turn
  // /_next/image into an open image proxy.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'is1-ssl.mzstatic.com' },
      { protocol: 'https', hostname: 'is2-ssl.mzstatic.com' },
      { protocol: 'https', hostname: 'is3-ssl.mzstatic.com' },
      { protocol: 'https', hostname: 'is4-ssl.mzstatic.com' },
      { protocol: 'https', hostname: 'is5-ssl.mzstatic.com' },
      { protocol: 'https', hostname: '**.mzstatic.com' },
    ],
    // Don't emit SVGs through the optimiser — SVG can carry script payloads.
    dangerouslyAllowSVG: false,
  },
  // Defence-in-depth headers — also cover static asset responses that
  // proxy.ts's matcher may not touch.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

module.exports = withNextIntl(nextConfig);
