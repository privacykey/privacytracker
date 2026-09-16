/** Run the real Node handlers with recorded Apple replies; never use the network. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discoveryStatements as base,
  DISCOVERY_EMPTY as EMPTY,
  DISCOVERY_APP as ID,
} from "../../scripts/parity/discovery-fixture.mjs";
import {
  statement as s,
  setting,
} from "../../scripts/parity/operations-fixture.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "pt-discovery-oracle-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = "1";
process.env.NEXT_PHASE = "phase-test";
delete process.env.AUDITOR_ADMIN_TOKEN;
let now = Date.UTC(2026, 8, 15, 12);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    super(...(a.length ? a : [now]));
  }
  static now() {
    return now;
  }
};
const { default: db } = await import("../../lib/db.ts");
const compare = (await import("../../app/api/compare/route.ts")).GET;
const related = (await import("../../app/api/related-apps/route.ts")).GET;
db.pragma("foreign_keys = OFF");
for (const { name } of db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()) {
  db.exec(`DELETE FROM "${name}"`);
}
const cases = [];
const reply = (body, status = 200) => ({
  body: typeof body === "string" ? body : JSON.stringify(body),
  status,
});
const url = "https://apps.apple.com/us/app/id90000001";
const html = (data, extra = "") =>
  `<meta property="og:title" content=" Preview on the App Store"><meta property="og:image" content="https://example.com/Icon.png">${extra}<script id="serialized-server-data">${JSON.stringify(data)}</script>`;
const payload = (shelfMapping = {}, extra = {}) => [
  { data: { shelfMapping, ...extra } },
];
async function run(
  name,
  route,
  query,
  { changes = [], replies = [], repeat = 1 } = {}
) {
  now += 61000;
  db.exec("SAVEPOINT discovery_case");
  const calls = [];
  let cursor = 0;
  globalThis.fetch = async (input, init) => {
    const call = {
      url: String(input),
      headers: [...new Headers(init?.headers)],
    };
    calls.push(call);
    const r = replies[cursor++];
    if (!r) {
      throw new Error(`Missing fixture reply ${call.url}`);
    }
    if (r.error) {
      throw new Error(r.error);
    }
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  try {
    for (const st of [...base, ...changes]) {
      db.prepare(st.sql).run(...st.params);
    }
    const before = db.prepare("SELECT total_changes() n").get().n;
    let expected;
    for (let i = 0; i < repeat; i++) {
      try {
        const response = await (route === "compare" ? compare : related)(
          new Request(
            `http://localhost/api/${route}?${new URLSearchParams(query)}`
          )
        );
        expected = {
          status: response.status,
          body: await response.text(),
          type: response.headers.get("content-type"),
          retry: response.headers.get("retry-after"),
        };
      } catch {
        expected = { status: 500, body: "", type: null, retry: null };
      }
    }
    if (before !== db.prepare("SELECT total_changes() n").get().n) {
      throw new Error(`GET wrote in ${name}`);
    }
    if (cursor !== replies.length) {
      throw new Error(
        `Unused/missing replies in ${name}: ${cursor}/${replies.length}`
      );
    }
    cases.push({
      name,
      route,
      query: [...new URLSearchParams(query)],
      changes,
      replies,
      repeat,
      calls,
      expected,
    });
  } finally {
    db.exec("ROLLBACK TO discovery_case; RELEASE discovery_case");
  }
}
const cmp = (name, a, b = `id:${ID}`, opts = {}) =>
  run(name, "compare", { a, b }, opts);
const preview = (name, data, extra = "", opts = {}) =>
  cmp(name, `url:${url}`, `id:${ID}`, {
    ...opts,
    replies: [reply(html(data, extra))],
  });
const rel = (name, query = {}, opts = {}) =>
  run(name, "related-apps", { sourceAppId: ID, ...query }, opts);
try {
  await run("compare missing", "compare", {});
  await cmp("compare empty", "", `id:${ID}`);
  await cmp("library populated and empty", `id:${ID}`, `id:${EMPTY}`);
  await cmp("library missing", "id:absent");
  await cmp("library no trim", `id: ${ID}`);
  await cmp("invalid spec", "invalid");
  await cmp("invalid spec surrogate", `${"a".repeat(39)}😀tail`);
  await run("repeated specs use first", "compare", [
    ["a", `id:${ID}`],
    ["a", "bad"],
    ["b", `id:${EMPTY}`],
  ]);
  for (const bad of [
    "",
    "ftp://apps.apple.com/id1",
    "https://example.com/id1",
    "http://127.0.0.1/id1",
    "https://apps.apple.com/app/no-id",
    "https://user:pass@apps.apple.com/id1",
  ]) {
    await cmp(`rejected ${bad}`, `url:${bad}`);
  }
  await cmp("compare local limiter", "url:invalid", `id:${ID}`, { repeat: 31 });
  for (const status of [403, 404, 429, 500]) {
    await cmp(`preview HTTP ${status}`, `url:${url}`, `id:${ID}`, {
      replies: [reply("", status)],
    });
  }
  await cmp("preview fetch fails", `url:${url}`, `id:${ID}`, {
    replies: [{ error: "fetch failed" }],
  });
  for (const [name, body] of [
    ["missing script", "<html>empty</html>"],
    ["invalid JSON", '<script id="serialized-server-data">bad</script>'],
    ["single quote script", "<script id='serialized-server-data'>[]</script>"],
    [
      "historical preview remains unsupported",
      '<script id="shoebox-media-api-cache-apps">{}</script>',
    ],
  ]) {
    await cmp(name, `url:${url}`, `id:${ID}`, { replies: [reply(body)] });
  }
  for (const data of [
    null,
    {},
    [],
    0,
    false,
    { data: [] },
    payload({}, { title: "  Clean title  " }),
    payload({}, { title: 1 }),
    payload({}, { title: "" }),
  ]) {
    await preview(`root ${JSON.stringify(data)}`, data);
  }
  const type = {
    identifier: "LINKED",
    title: "Linked",
    categories: [{ identifier: "CONTACT", title: "Contact" }],
  };
  await preview(
    "direct privacy preferred",
    payload({
      privacyTypes: { items: [type] },
      privacyHeader: {
        seeAllAction: {
          pageData: {
            shelves: [
              {
                contentType: "privacyType",
                items: [{ ...type, title: "wrong" }],
              },
            ],
          },
        },
      },
    })
  );
  await preview("wrapped modern", {
    data: payload({ privacyTypes: { items: [type] } }),
    userTokenHash: "unused",
  });
  for (const items of [
    [null],
    "bad",
    [
      {
        identifier: 5,
        title: false,
        categories: [{ identifier: ["a", null, "b"], title: {} }],
      },
    ],
    [{ identifier: "empty" }],
    [{ categories: 2 }],
    [{ categories: [null] }],
  ]) {
    await preview(
      `malformed/coerced items ${JSON.stringify(items)}`,
      payload({ privacyTypes: { items } })
    );
  }
  await preview(
    "header flatten first duplicate wins",
    payload({
      privacyHeader: {
        seeAllAction: {
          pageData: {
            shelves: [
              { contentType: "ignore" },
              {
                contentType: "privacyType",
                items: [
                  {
                    identifier: "LEGACY",
                    title: "Legacy",
                    purposes: [
                      { categories: [{ identifier: "a", title: "First" }] },
                      {
                        categories: [
                          { identifier: "a", title: "Second" },
                          { identifier: "b", title: "Other" },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    })
  );
  await preview(
    "generic fallback",
    payload(
      {},
      { pageData: { shelves: [{ contentType: "privacyType", items: [type] }] } }
    )
  );
  await preview(
    "selection failure keeps preceding rows",
    payload({
      privacyHeader: {
        seeAllAction: {
          pageData: {
            shelves: [{ contentType: "privacyType", items: [type, null] }],
          },
        },
      },
    })
  );
  const features = [
    null,
    0,
    { title: 2 },
    {
      title: "  VoiceOver ",
      description: " Spoken ",
      artwork: { template: "systemimage://vo" },
    },
    { title: "voiceover", description: "duplicate" },
    { title: "😀" },
    { title: "  Larger Text ", description: " " },
    { title: "x".repeat(70) },
    { title: "İ Voice" },
  ];
  for (const [label, map] of [
    ["absent", {}],
    ["header empty", { accessibilityHeader: {} }],
    ["compact", { accessibilityFeatures: { items: [null, { features }] } }],
    [
      "rich preferred",
      {
        accessibilityHeader: {
          seeAllAction: {
            pageData: {
              shelves: [
                null,
                { contentType: "accessibilityFeatures", items: [{ features }] },
              ],
            },
          },
        },
        accessibilityFeatures: { items: [{ features: [{ title: "Wrong" }] }] },
      },
    ],
    [
      "rich empty preferred",
      {
        accessibilityHeader: {
          seeAllAction: {
            pageData: {
              shelves: [
                {
                  contentType: "accessibilityFeatures",
                  items: [{ features: [] }],
                },
              ],
            },
          },
        },
        accessibilityFeatures: { items: [{ features }] },
      },
    ],
  ]) {
    await preview(`accessibility ${label}`, payload(map));
  }
  for (const [label, extra] of [
    ["author", '"author":{"@type":"Org","name":"Original Case"}'],
    [
      "aria before",
      '<a aria-label="Developer’s Privacy Policy" href="https://example.com/Case">',
    ],
    [
      "href before",
      '<A HREF="https://example.com/Case" aria-label="Developer\'s Privacy Policy">',
    ],
    [
      "legacy case insensitive",
      '<div ID="notPurchasedLinks"><A HREF="https://example.com/Case">Privacy Policy</A>',
    ],
    [
      "blocked policy",
      '<a href="http://127.0.0.1/private" aria-label="Developer\'s Privacy Policy">',
    ],
    [
      "bounded policy",
      `<a ${"x".repeat(2049)} href="https://example.com/Case" aria-label="Developer's Privacy Policy">`,
    ],
  ]) {
    await preview(label, [], extra);
  }
  await cmp("two parallel previews", `url:${url}`, `url:${url}`, {
    replies: [
      reply(html(payload({}, { title: "First" }))),
      reply(html(payload({}, { title: "Second" }))),
    ],
  });
  for (const sourceAppId of ["", "bad id", "😀", "absent"]) {
    await rel(`source ${sourceAppId}`, { sourceAppId });
  }
  await rel("missing genre skips nonnumeric lookup", { sourceAppId: EMPTY });
  await rel("stored empty", { sourceAppId: EMPTY, mode: "may_also_like" });
  for (const limit of [
    undefined,
    "",
    "0",
    "-1",
    "2",
    "2.9",
    "0x2",
    "0b10",
    "0o2",
    "invalid",
    "Infinity",
    "10",
    "999",
    "1e1",
    "\ufeff2 ",
  ]) {
    await rel(`stored limit ${limit}`, {
      mode: "may_also_like",
      ...(limit === undefined ? {} : { limit }),
    });
  }
  const entry = (id, name = ` Candidate ${id} `) => ({
    id: { attributes: { "im:id": id } },
    "im:name": { label: name },
    "im:artist": { label: " Developer " },
    "im:image": [{ label: "small" }, { label: "large" }],
    link: [
      { attributes: { href: `https://apps.apple.com/id${id}` } },
      { attributes: { href: "ignored" } },
    ],
  });
  const feed = {
    feed: {
      entry: [
        entry(ID),
        entry("002"),
        entry("001"),
        entry("002"),
        entry("003"),
      ],
    },
  };
  for (const limit of [
    undefined,
    "",
    "0",
    "-1",
    "2",
    "2.9",
    "0x2",
    "0b10",
    "0o2",
    "invalid",
    "Infinity",
    "10",
  ]) {
    await rel(`feed limit ${limit}`, limit === undefined ? {} : { limit }, {
      replies: [reply(feed)],
    });
  }
  for (const country of [" AU ", "GB", "invalid", "İs", ""]) {
    await rel(
      `country ${country}`,
      { limit: "3" },
      { changes: [setting("app_country", country)], replies: [reply(feed)] }
    );
  }
  await rel(
    "paid feed and unknown mode",
    { mode: "future" },
    {
      changes: [s("UPDATE apps SET priceAmount=1.99 WHERE id=?", ID)],
      replies: [reply(feed)],
    }
  );
  for (const body of [
    "bad",
    null,
    {},
    { feed: { entry: {} } },
    { feed: { entry: [entry("001"), null] } },
    { feed: { entry: [entry("001"), entry("002", 3)] } },
    {
      feed: {
        entry: [
          {
            id: { attributes: { "im:id": "a" } },
            "im:name": { label: "A" },
            link: { attributes: { href: "link" } },
          },
        ],
      },
    },
  ]) {
    await rel(
      `feed shape ${JSON.stringify(body)}`,
      { limit: "10" },
      { replies: [reply(body)] }
    );
  }
  for (const r of [reply("", 429), reply("", 500), { error: "fetch failed" }]) {
    await rel(`feed soft failure ${JSON.stringify(r)}`, {}, { replies: [r] });
  }
  const missing = [
    s(
      "UPDATE apps SET genreId=NULL,genreName=NULL,priceAmount=NULL WHERE id=?",
      ID
    ),
  ];
  const lookup = reply({
    results: [{ primaryGenreId: 6014, primaryGenreName: "Games", price: 2.5 }],
  });
  await rel(
    "lookup fills without writes",
    {},
    { changes: missing, replies: [lookup, reply(feed)] }
  );
  await rel(
    "lookup retains cached genre",
    {},
    {
      changes: [s("UPDATE apps SET priceAmount=NULL WHERE id=?", ID)],
      replies: [lookup, reply(feed)],
    }
  );
  for (const r of [
    reply("bad"),
    reply(null),
    reply({ results: [] }),
    reply({ results: [{ primaryGenreId: "6014", price: "0" }] }),
    reply("", 429),
    { error: "fetch failed" },
  ]) {
    await rel(
      `lookup soft failure ${JSON.stringify(r)}`,
      {},
      { changes: missing, replies: [r] }
    );
  }
  await rel(
    "lookup failure defaults known genre free",
    {},
    {
      changes: [s("UPDATE apps SET priceAmount=NULL WHERE id=?", ID)],
      replies: [{ error: "fetch failed" }, reply(feed)],
    }
  );
  await rel("source database failure", {}, { changes: [s("DROP TABLE apps")] });
  await rel(
    "stored database failure",
    { mode: "may_also_like" },
    { changes: [s("DROP TABLE related_apps_observed")] }
  );
  writeFileSync(
    new URL("../tests/fixtures/discovery-cases.json", import.meta.url),
    `${JSON.stringify({ base, cases }, null, 2)}\n`
  );
  console.log(
    `Recorded ${cases.length} actual Node discovery cases; no database writes.`
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
