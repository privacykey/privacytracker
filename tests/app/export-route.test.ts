import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../../app/api/export/route";
import db from "../../lib/db";
import {
  resetTestDb,
  seedPrivacyCategory,
  seedTrackedApp,
} from "../helpers/test-db";

const CSV_HEADER =
  '"App Name","Developer","URL","Last Synced","Privacy Type","Category"';

test.beforeEach(resetTestDb);

function getExport(query: string) {
  return GET(new Request(`http://127.0.0.1/api/export${query}`));
}

for (const query of ["", "?format=csv"]) {
  const label = query || "(default format)";

  test(`CSV export ${label} has readable headers with no apps`, async () => {
    const response = await getExport(query);

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/csv; charset=utf-8"
    );
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /^attachment; filename="privacytracker-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    assert.equal(await response.text(), CSV_HEADER);
  });

  test(`CSV export ${label} preserves headers and escapes data fields`, async () => {
    seedTrackedApp({
      id: "1000",
      name: 'Maps, "Local"',
      developer: "Café\nStudio",
    });
    seedPrivacyCategory({
      appId: "1000",
      typeIdentifier: "DATA_USED_TO_TRACK_YOU",
      typeTitle: "Data Used to Track You",
      categoryIdentifier: "LOCATION",
      categoryTitle: "Location",
    });
    db.prepare("UPDATE apps SET lastSynced = ? WHERE id = ?").run(
      Date.UTC(2026, 8, 5),
      "1000"
    );

    const response = await getExport(query);

    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      `${CSV_HEADER}\n"Maps, ""Local""","Café\nStudio","https://apps.apple.com/us/app/fixture/id1000","2026-09-05","Data Used to Track You","Location"`
    );
  });
}

test("CSV export renders missing metadata and an unset sync date as empty fields", async () => {
  db.prepare(
    "INSERT INTO apps (id, name, url, lastSynced) VALUES (?, ?, ?, ?)"
  ).run("1000", "Example App", "https://apps.apple.com/us/app/id1000", 0);

  const response = await getExport("?format=csv");

  assert.equal(response.status, 200);
  assert.equal(
    await response.text(),
    `${CSV_HEADER}\n"Example App","","https://apps.apple.com/us/app/id1000","","",""`
  );
});

test("JSON export keeps its structured payload", async () => {
  seedTrackedApp({ id: "1000", name: 'Maps, "Local"' });

  const response = await getExport("?format=json");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.ok(Number.isFinite(Date.parse(body.exported_at)));
  assert.equal(body.apps.length, 1);
  assert.equal(body.apps[0].id, "1000");
  assert.equal(body.apps[0].name, 'Maps, "Local"');
  assert.deepEqual(body.apps[0].privacyTypes, []);
});

for (const value of [
  "=1+2",
  "+1",
  "-1",
  "@SUM(1)",
  "＝1+2",
  "＋1",
  "－1",
  "＠SUM(1)",
  " \t=1+2",
  "\u0000=1+2",
  "\r=1+2",
  "\n=1+2",
  "\ttext",
  '=HYPERLINK("https://example.invalid/","label")',
]) {
  test(`CSV treats formula-looking values as text: ${JSON.stringify(value)}`, async () => {
    seedTrackedApp({ id: "1000", name: value, developer: value });
    seedPrivacyCategory({
      appId: "1000",
      typeIdentifier: "DATA_USED_TO_TRACK_YOU",
      typeTitle: value,
      categoryIdentifier: "LOCATION",
      categoryTitle: value,
    });
    db.prepare("UPDATE apps SET url = ? WHERE id = ?").run(value, "1000");
    const response = await getExport("?format=csv");
    const csv = await response.text();
    const quoted = `"\t${value.replace(/"/g, '""')}"`;
    assert.equal(csv.split(quoted).length - 1, 5);
    assert.ok(csv.startsWith(`${CSV_HEADER}\n`));
    const json = await (await getExport("?format=json")).json();
    assert.equal(json.apps[0].name, value);
    assert.equal(json.apps[0].developer, value);
    assert.equal(json.apps[0].url, value);
  });
}
