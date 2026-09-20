/**
 * Page parity (Rust core Phase 6, batch 3a): the frontend, served by both
 * servers from the same `next build`, compared request by request.
 *
 * The core serves the build it is started with (`pt-core serve --site
 * <dir>`); read-parity starts it on its own working directory, so run the
 * Node server from the same checkout, on the same build.
 *
 * For every prerendered page: the document, HEAD, the RSC payload a client
 * navigation fetches, a prefetch, and each segment file a segment prefetch
 * asks for, all with the `_rsc` Next's own client would send (computed by
 * Next's own function). Then the two rewrites, the not-found page, a
 * sample of `/_next/static`, every `public/` file, the three icons, and
 * the edges recorded from `next start` while porting: conditional
 * requests, ranges, compression, other methods, the redirects, encoded
 * and dot-segment paths, and a few requests without the token.
 *
 * Each pair is compared on the status, the body (decompressed when the
 * response was compressed) and every header by name, duplicates in order,
 * except the transport ones (`date`, `connection`, `keep-alive`,
 * `transfer-encoding`); `content-length` only where Node sends one, since
 * Node streams what the core sends whole.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { gunzipSync, inflateSync } from "node:zlib";

const TRANSPORT = new Set([
  "date",
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

function send(base, spec) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: spec.method ?? "GET",
        path: spec.path,
        headers: spec.headers ?? {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const headers = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            headers.push([
              res.rawHeaders[i].toLowerCase(),
              res.rawHeaders[i + 1],
            ]);
          }
          resolve({
            status: res.statusCode,
            headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function decoded(r) {
  const encoding = r.headers.find(([k]) => k === "content-encoding")?.[1];
  if (encoding === "gzip") {
    return gunzipSync(r.body);
  }
  if (encoding === "deflate") {
    return inflateSync(r.body);
  }
  return r.body;
}

function differences(n, r) {
  const out = [];
  if (n.status !== r.status) {
    out.push(`status ${n.status} vs ${r.status}`);
  }
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  // Assigned by both branches: a body that will not decode counts as a
  // difference rather than throwing out of the comparison.
  let bodies;
  try {
    bodies = sha(decoded(n)) === sha(decoded(r));
  } catch {
    bodies = false;
  }
  if (!bodies) {
    out.push(`body ${n.body.length}B vs ${r.body.length}B`);
  }
  const byName = (headers) => {
    const map = new Map();
    for (const [k, v] of headers) {
      if (TRANSPORT.has(k)) {
        continue;
      }
      if (!map.has(k)) {
        map.set(k, []);
      }
      map.get(k).push(v);
    }
    return map;
  };
  const hn = byName(n.headers);
  const hr = byName(r.headers);
  if (!hn.has("content-length")) {
    hr.delete("content-length");
  }
  for (const key of new Set([...hn.keys(), ...hr.keys()])) {
    const a = JSON.stringify(hn.get(key) ?? null);
    const b = JSON.stringify(hr.get(key) ?? null);
    if (a !== b) {
      out.push(`${key}: ${a.slice(0, 160)} vs ${b.slice(0, 160)}`);
    }
  }
  return out;
}

/** Every prerendered route and its segments, from the build itself. */
function buildRoutes(appDir) {
  const routes = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (name.endsWith(".html")) {
        const stem = path.relative(appDir, full).replace(/\.html$/, "");
        const meta = JSON.parse(
          readFileSync(path.join(appDir, `${stem}.meta`), "utf8")
        );
        routes.push({
          route: stem === "index" ? "/" : `/${stem}`,
          segments: meta.segmentPaths ?? [],
        });
      }
    }
  };
  walk(appDir);
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

export async function probePages(nodeBase, rustBase, token, root) {
  const appDir = path.join(root, ".next", "server", "app");
  if (!existsSync(appDir)) {
    console.log(
      "  ✘ pages: no build in the working directory (run `pnpm build`)"
    );
    return false;
  }
  const require = createRequire(path.join(root, "package.json"));
  const {
    computeCacheBustingSearchParam,
  } = require("next/dist/shared/lib/router/utils/cache-busting-search-param.js");
  const auth = { "x-auditor-admin-token": token };
  const specs = [];
  const add = (name, spec) => specs.push({ name, ...spec });
  const rscPath = async (route, headers) => {
    const lower = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );
    const hash = await computeCacheBustingSearchParam(
      lower["next-router-prefetch"],
      lower["next-router-segment-prefetch"],
      lower["next-router-state-tree"],
      lower["next-url"]
    );
    const sep = route.includes("?") ? "&" : "?";
    return `${route}${sep}${hash ? `_rsc=${hash}` : "_rsc"}`;
  };
  const rsc = async (name, route, extra = {}) =>
    add(name, {
      path: await rscPath(route, extra),
      headers: { ...auth, RSC: "1", ...extra },
    });

  const routes = buildRoutes(appDir);
  for (const { route, segments } of routes) {
    add(`document ${route}`, { path: route, headers: auth });
    add(`HEAD ${route}`, { method: "HEAD", path: route, headers: auth });
    await rsc(`rsc ${route}`, route);
    await rsc(`prefetch ${route}`, route, { "Next-Router-Prefetch": "1" });
    for (const segment of segments) {
      await rsc(`segment ${segment} ${route}`, route, {
        "Next-Router-Prefetch": "1",
        "Next-Router-Segment-Prefetch": segment,
      });
    }
  }
  for (const route of ["/apps/12345", "/manual-apps/abc", "/no-such-page"]) {
    add(`document ${route}`, { path: route, headers: auth });
    add(`HEAD ${route}`, { method: "HEAD", path: route, headers: auth });
    await rsc(`rsc ${route}`, route);
    await rsc(`segment /_tree ${route}`, route, {
      "Next-Router-Prefetch": "1",
      "Next-Router-Segment-Prefetch": "/_tree",
    });
  }

  const staticDir = path.join(root, ".next", "static");
  const statics = [];
  const collect = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        collect(full, `${prefix}/${name}`);
      } else {
        statics.push(`${prefix}/${name}`);
      }
    }
  };
  collect(staticDir, "/_next/static");
  const js = statics.filter((p) => p.endsWith(".js"));
  const css = statics.filter((p) => p.endsWith(".css"));
  const sample = [
    ...js.slice(0, 6),
    ...css.slice(0, 3),
    ...statics.filter((p) => !(p.endsWith(".js") || p.endsWith(".css"))),
  ];
  for (const file of sample) {
    add(`static ${file}`, { path: file });
  }
  const publicDir = path.join(root, "public");
  const listPublic = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        listPublic(full, `${prefix}/${name}`);
      } else {
        add(`public ${prefix}/${name}`, {
          path: `${prefix}/${name}`,
          headers: auth,
        });
      }
    }
  };
  listPublic(publicDir, "");
  for (const icon of ["/favicon.ico", "/icon.png", "/apple-icon.png"]) {
    add(`icon ${icon}`, { path: icon, headers: auth });
  }

  // The edges recorded from `next start` while porting.
  const doc = "/login";
  const [firstJs] = js;
  const edges = [
    [
      "gzip document",
      { path: doc, headers: { ...auth, "Accept-Encoding": "gzip" } },
    ],
    [
      "deflate document",
      { path: doc, headers: { ...auth, "Accept-Encoding": "deflate" } },
    ],
    [
      "br-only document",
      { path: doc, headers: { ...auth, "Accept-Encoding": "br" } },
    ],
    [
      "weighted encodings",
      {
        path: doc,
        headers: { ...auth, "Accept-Encoding": "gzip;q=0.5, deflate;q=0.8" },
      },
    ],
    [
      "gzip rsc",
      {
        path: `${doc}?_rsc`,
        headers: { ...auth, RSC: "1", "Accept-Encoding": "gzip" },
      },
    ],
    ["gzip static", { path: firstJs, headers: { "Accept-Encoding": "gzip" } }],
    [
      "gzip icon",
      { path: "/icon.png", headers: { ...auth, "Accept-Encoding": "gzip" } },
    ],
    [
      "HEAD gzip document",
      {
        method: "HEAD",
        path: doc,
        headers: { ...auth, "Accept-Encoding": "gzip" },
      },
    ],
    ["etag *", { path: doc, headers: { ...auth, "If-None-Match": "*" } }],
    [
      "etag no-cache",
      {
        path: doc,
        headers: { ...auth, "If-None-Match": "*", "Cache-Control": "no-cache" },
      },
    ],
    [
      "etag and ims",
      {
        path: doc,
        headers: {
          ...auth,
          "If-None-Match": "*",
          "If-Modified-Since": "Thu, 17 Sep 2099 08:28:48 GMT",
        },
      },
    ],
    [
      "not found etag",
      { path: "/no-such-page", headers: { ...auth, "If-None-Match": "*" } },
    ],
    ["static etag *", { path: firstJs, headers: { "If-None-Match": "*" } }],
    [
      "static no-cache etag",
      {
        path: firstJs,
        headers: { "If-None-Match": "*", "Cache-Control": "no-cache" },
      },
    ],
    [
      "static ims future",
      {
        path: firstJs,
        headers: { "If-Modified-Since": "Thu, 17 Sep 2099 08:28:48 GMT" },
      },
    ],
    ["static range", { path: firstJs, headers: { Range: "bytes=0-9" } }],
    ["static suffix range", { path: firstJs, headers: { Range: "bytes=-5" } }],
    [
      "static two ranges",
      { path: firstJs, headers: { Range: "bytes=0-1,10-11" } },
    ],
    [
      "static bad range",
      { path: firstJs, headers: { Range: "bytes=99999999-" } },
    ],
    ["static if-match", { path: firstJs, headers: { "If-Match": '"nope"' } }],
    [
      "static if-range stale",
      { path: firstJs, headers: { Range: "bytes=0-5", "If-Range": '"nope"' } },
    ],
    ["static missing", { path: "/_next/static/chunks/no-such.js" }],
    ["static POST", { method: "POST", path: firstJs }],
    [
      "public range",
      { path: "/brand-icon.png", headers: { ...auth, Range: "bytes=10-19" } },
    ],
    ["public POST", { method: "POST", path: "/brand-icon.png", headers: auth }],
    ["page POST", { method: "POST", path: "/dashboard", headers: auth }],
    ["page DELETE", { method: "DELETE", path: "/dashboard", headers: auth }],
    ["page OPTIONS", { method: "OPTIONS", path: "/dashboard", headers: auth }],
    ["icon POST", { method: "POST", path: "/icon.png", headers: auth }],
    [
      "not found POST",
      { method: "POST", path: "/no-such-page", headers: auth },
    ],
    ["api 405", { method: "PUT", path: "/api/health", headers: auth }],
    ["unknown api", { path: "/api/no-such-route", headers: auth }],
    ["_next data", { path: "/_next/data/x.json", headers: auth }],
    [
      "_next image",
      { path: "/_next/image?url=%2Fbrand-icon.png&w=64&q=75", headers: auth },
    ],
    [
      "rsc without _rsc",
      { path: "/dashboard", headers: { ...auth, RSC: "1" } },
    ],
    [
      "rsc wrong _rsc",
      {
        path: "/dashboard?tab=x&_rsc=abc12",
        headers: { ...auth, RSC: "1", "Next-Router-Prefetch": "1" },
      },
    ],
    [
      "rsc bare _rsc kept",
      {
        path: "/dashboard?_rsc&x=%20y",
        headers: { ...auth, RSC: "1", "Next-Router-Prefetch": "1" },
      },
    ],
    [
      "rsc rewrite redirect",
      { path: "/apps/7", headers: { ...auth, RSC: "1" } },
    ],
    [
      "segment missing",
      {
        path: await rscPath("/dashboard", {
          "Next-Router-Prefetch": "1",
          "Next-Router-Segment-Prefetch": "/_head",
        }),
        headers: {
          ...auth,
          RSC: "1",
          "Next-Router-Prefetch": "1",
          "Next-Router-Segment-Prefetch": "/_head",
        },
      },
    ],
    [
      "RSC: 2 is a document",
      { path: "/dashboard?_rsc", headers: { ...auth, RSC: "2" } },
    ],
    ["trailing slash", { path: "/dashboard/?x=1", headers: auth }],
    ["double slash", { path: "//dashboard?x=1", headers: auth }],
    ["double slash api", { path: "//api/health" }],
    ["dot segments", { path: "/dashboard/../login", headers: auth }],
    ["dot segments static", { path: "/_next/static/../BUILD_ID" }],
    ["encoded dot segments", { path: "/api/x/%2e%2e/health" }],
    [
      "encoded static name",
      {
        path: firstJs.replace(
          /\/([^/])([^/]*)$/,
          (_, c, rest) => `/%${c.charCodeAt(0).toString(16)}${rest}`
        ),
      },
    ],
    ["encoded page name", { path: "/%64ashboard", headers: auth }],
    ["encoded slash", { path: "/dashboard%2F", headers: auth }],
    [
      "uppercase static",
      { path: firstJs.replace("/_next/", "/_NEXT/"), headers: auth },
    ],
    ["global error page", { path: "/_global-error", headers: auth }],
    ["not-found page direct", { path: "/_not-found", headers: auth }],
    ["index path", { path: "/index", headers: auth }],
    // No token: pages go to /login, the public reads and static assets do not.
    ["no token page", { path: "/dashboard" }],
    ["no token rsc", { path: "/dashboard?_rsc", headers: { RSC: "1" } }],
    ["no token login", { path: "/login" }],
    ["no token login rsc", { path: "/login?_rsc", headers: { RSC: "1" } }],
    ["no token brand icon", { path: "/brand-icon.png" }],
    ["no token icon", { path: "/icon.png" }],
    ["no token favicon", { path: "/favicon.ico" }],
    ["no token font", { path: "/fonts/InterVariable.woff2" }],
    ["no token static", { path: firstJs }],
    ["no token not found", { path: "/no-such-page" }],
    ["no token api", { path: "/api/stats" }],
    ["no token trailing slash", { path: "/dashboard/" }],
    [
      "host not allowed page",
      { path: "/dashboard", headers: { ...auth, Host: "evil.example" } },
    ],
    [
      "host not allowed static",
      { path: firstJs, headers: { Host: "evil.example" } },
    ],
  ];
  for (const [name, spec] of edges) {
    add(name, spec);
  }

  let failed = 0;
  for (const spec of specs) {
    const [n, r] = await Promise.all([
      send(nodeBase, spec),
      send(rustBase, spec),
    ]);
    const diffs = differences(n, r);
    if (diffs.length) {
      failed += 1;
      console.log(`  ✘ pages: ${spec.name}`);
      for (const d of diffs.slice(0, 6)) {
        console.log(`      ${d}`);
      }
    }
  }
  const pages = routes.length;
  console.log(
    `  ${failed === 0 ? "✔" : "✘"} pages: ${specs.length - failed}/${specs.length} requests identical (${pages} prerendered pages, their RSC and segments, static, public, icons and ${edges.length} edges)`
  );
  return failed === 0;
}
