/**
 * The audit bundle, live on both servers (Rust core Phase 4, batch 5c).
 *
 * The differ cannot gate these two routes. The export is refused under
 * the seeded focus and answers with a download; the import takes an
 * upload — multipart from the real client — and is only interesting when
 * the upload is a real one. So this probe turns the export flag on, takes
 * each server's OWN export of the seeded install, and feeds it to both:
 * previewed as JSON, previewed as a multipart upload, committed, committed
 * again (a duplicate), committed again on purpose. A bundle written by
 * either backend has to read, and merge, identically on the other. The
 * older export goes first, so that each bundle's first import updates
 * apps and its second skips them all, whichever server answered first.
 *
 * Runs after the differ's mutation pass and BEFORE the backup probe, which
 * is destructive and must stay last. The rows an import writes carry each
 * server's own random ids; nothing after this compares them.
 */

const EXPORT_FLAG = "flag.settings.admin.export.audit_bundle";
const EXPORT_DISPOSITION =
  /^attachment; filename="parity-\d{4}-\d{2}-\d{2}-\d{4}\.audit\.json"$/;
const BOUNDARY = "----ptParityBoundaryA1b2C3d4E5f6G7h8";

export async function probeBundleRoutes(nodeBase, rustBase, token) {
  let ok = true;
  const check = (claim, pass, detail = "") => {
    console.log(`  ${pass ? "✔" : "✘"} bundles: ${claim}`);
    if (!pass && detail) {
      console.log(`    ${detail}`);
    }
    ok = pass && ok;
    return pass;
  };
  const send = async (base, method, route, body, contentType) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        origin: base,
        "x-auditor-admin-token": token,
        ...(body === undefined
          ? {}
          : { "content-type": contentType ?? "application/json" }),
      },
      body,
    });
    return {
      status: res.status,
      text: await res.text(),
      type: res.headers.get("content-type"),
      disposition: res.headers.get("content-disposition"),
      cache: res.headers.get("cache-control"),
    };
  };
  const both = (...args) =>
    Promise.all([send(nodeBase, ...args), send(rustBase, ...args)]);
  const short = (r) => JSON.stringify(r).slice(0, 400);
  const same = (a, b) =>
    a.status === b.status && a.text === b.text && a.type === b.type;
  const multipart = (content, { asFile = true } = {}) =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"${
      asFile ? '; filename="parity.audit.json"' : ""
    }\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${BOUNDARY}--\r\n`;
  const multipartType = `multipart/form-data; boundary=${BOUNDARY}`;

  // ── the gate, then the export ──────────────────────────────────────
  const [refusedNode, refusedRust] = await both(
    "POST",
    "/api/export/audit-bundle",
    "{}"
  );
  check(
    "the export is refused identically under the seeded focus",
    refusedNode.status === 403 && same(refusedNode, refusedRust),
    `node=${short(refusedNode)} rust=${short(refusedRust)}`
  );
  const [flagNode, flagRust] = await both(
    "POST",
    "/api/feature-flags/overrides",
    JSON.stringify({ key: EXPORT_FLAG, value: "on" })
  );
  if (
    !check(
      "the export flag is overridden on, on both",
      flagNode.status === 200 && flagRust.status === 200,
      `node=${short(flagNode)} rust=${short(flagRust)}`
    )
  ) {
    return false;
  }
  const [nodeExport, rustExport] = await both(
    "POST",
    "/api/export/audit-bundle",
    JSON.stringify({ recommenderName: "Parity" })
  );
  const exportsOk = check(
    "both servers export a bundle as a download named for the recommender",
    [nodeExport, rustExport].every(
      (r) =>
        r.status === 200 &&
        r.type === "application/json" &&
        r.cache === "no-store" &&
        EXPORT_DISPOSITION.test(r.disposition ?? "")
    ),
    `node=${short({ ...nodeExport, text: undefined })} rust=${short({ ...rustExport, text: undefined })}`
  );
  if (!exportsOk) {
    return false;
  }
  const nodeBundle = JSON.parse(nodeExport.text);
  const rustBundle = JSON.parse(rustExport.text);
  check(
    "the Rust bundle is laid out byte for byte as JSON.stringify(v, null, 2) lays it out",
    rustExport.text === JSON.stringify(rustBundle, null, 2)
  );
  // Everything but the export time and the rows the mutation pass wrote
  // with each server's own ids and clock.
  const stable = (b) =>
    JSON.stringify({
      ...b,
      exported_at: "clock",
      annotations: b.annotations.length,
      verdicts: b.verdicts.map((v) => [v.app_id, v.verdict, v.rationale]),
    });
  check(
    `both bundles carry the same ${nodeBundle.apps.length} apps, labels, accessibility features, policy summaries, profile and preset`,
    nodeBundle.apps.length > 0 && stable(nodeBundle) === stable(rustBundle),
    `node=${stable(nodeBundle).slice(0, 300)} rust=${stable(rustBundle).slice(0, 300)}`
  );

  // ── the import: each server's bundle, fed to both ──────────────────
  // OLDER EXPORT FIRST. The importer dates an app that has no policy
  // summary by the bundle's `exported_at`, and skips it unless that is
  // newer than the install's copy. The two exports were taken a moment
  // apart, in whichever order the servers answered: imported newer-first,
  // the second bundle would be older than everything the first just
  // wrote, every app in it skipped, and its import would exercise
  // nothing. Older-first, each bundle's first import updates and its
  // re-import meets the equal-timestamp rule, whoever answered first.
  const bundles = [
    ["Node's bundle", nodeExport.text, Date.parse(nodeBundle.exported_at)],
    ["Rust's bundle", rustExport.text, Date.parse(rustBundle.exported_at)],
  ].sort((a, b) => a[2] - b[2]);
  let importedUpTo = Number.NEGATIVE_INFINITY;
  for (const [label, text, exportedAt] of bundles) {
    // Strictly newer than the last bundle imported (always, for the
    // first). The two exports landing in the same millisecond is the one
    // case where this bundle's first import has nothing left to update.
    const newer = exportedAt > importedUpTo;
    importedUpTo = exportedAt;
    const [jsonNode, jsonRust] = await both(
      "POST",
      "/api/import/audit-bundle",
      text
    );
    check(
      `${label} previews identically as JSON`,
      jsonNode.status === 200 && same(jsonNode, jsonRust),
      `node=${short(jsonNode)} rust=${short(jsonRust)}`
    );
    const [formNode, formRust] = await both(
      "POST",
      "/api/import/audit-bundle",
      multipart(text),
      multipartType
    );
    check(
      `${label} previews identically as a multipart upload, and as it did as JSON`,
      same(formNode, formRust) && formRust.text === jsonRust.text,
      `node=${short(formNode)} rust=${short(formRust)}`
    );
    const [commitNode, commitRust] = await both(
      "POST",
      "/api/import/audit-bundle?confirm=1",
      multipart(text),
      multipartType
    );
    const updatedSome = (r) => {
      try {
        return JSON.parse(r.text).summary.appsUpdated > 0;
      } catch {
        return false;
      }
    };
    check(
      `${label} imports with the same summary on both${newer ? ", updating the apps it is newer than" : ""}`,
      commitNode.status === 200 &&
        same(commitNode, commitRust) &&
        (!newer || (updatedSome(commitNode) && updatedSome(commitRust))),
      `node=${short(commitNode)} rust=${short(commitRust)}`
    );
    const [againNode, againRust] = await both(
      "POST",
      "/api/import/audit-bundle?confirm=1",
      text
    );
    // The message names when the first import landed, to the second, in
    // the server's locale: the two landed a moment apart, so the clock is
    // masked and the rest — wording, date, 12-hour spelling — is compared.
    const masked = (r) => {
      try {
        const j = JSON.parse(r.text);
        return JSON.stringify({
          ...j,
          existingImport: { ...j.existingImport, importedAt: "clock" },
          message: String(j.message)
            .replaceAll(String.fromCharCode(0x20_2f), " ")
            .replace(/\d{1,2}:\d{2}:\d{2}/, "h:mm:ss"),
        });
      } catch {
        return r.text;
      }
    };
    check(
      `${label} is refused as a duplicate the second time, in the same words`,
      againNode.status === 409 &&
        againRust.status === 409 &&
        masked(againNode) === masked(againRust) &&
        /on \d{1,2}\/\d{1,2}\/\d{4}, h:mm:ss [AP]M\.$/.test(
          JSON.parse(masked(againRust)).message
        ),
      `node=${masked(againNode).slice(0, 300)} rust=${masked(againRust).slice(0, 300)}`
    );
    const [forcedNode, forcedRust] = await both(
      "POST",
      "/api/import/audit-bundle?confirm=1&allowDuplicate=1",
      text
    );
    // Held to the rule itself, not only to agreement: after the import
    // above, nothing in this bundle is newer than the install's copy, so
    // a second pass must add nothing, update nothing and skip every app.
    const skippedAll = (r) => {
      try {
        const s = JSON.parse(r.text).summary;
        return (
          s.appsAdded === 0 &&
          s.appsUpdated === 0 &&
          s.appsSkipped === s.appsTotal
        );
      } catch {
        return false;
      }
    };
    check(
      `${label} imports again when the duplicate is allowed, skipping every app because none is newer`,
      forcedNode.status === 200 &&
        same(forcedNode, forcedRust) &&
        skippedAll(forcedNode) &&
        skippedAll(forcedRust),
      `node=${short(forcedNode)} rust=${short(forcedRust)}`
    );
  }

  // ── uploads that are not bundles ───────────────────────────────────
  for (const [label, body, type] of [
    [
      "a text field named file",
      multipart("{}", { asFile: false }),
      multipartType,
    ],
    ["a file that is not JSON", multipart("{not json"), multipartType],
    [
      "a multipart body under another boundary",
      multipart("{}"),
      "multipart/form-data; boundary=----ptSomeOtherBoundary0123456789",
    ],
    [
      "a multipart body with no boundary parameter",
      multipart("{}"),
      "multipart/form-data",
    ],
    [
      "a bundle from a newer app",
      JSON.stringify({ ...nodeBundle, version: 99 }),
    ],
    [
      "an app with no name",
      JSON.stringify({ ...nodeBundle, apps: [{ id: "1" }] }),
    ],
    ["an empty body", ""],
  ]) {
    const [a, b] = await both("POST", "/api/import/audit-bundle", body, type);
    check(
      `${label} is refused identically (HTTP ${a.status})`,
      a.status >= 400 && same(a, b),
      `node=${short(a)} rust=${short(b)}`
    );
  }

  // ── put the flag back ──────────────────────────────────────────────
  const [clearNode, clearRust] = await both(
    "DELETE",
    `/api/feature-flags/overrides/${EXPORT_FLAG}`
  );
  check(
    "the export flag override is cleared on both",
    clearNode.status === 200 && clearRust.status === 200,
    `node=${short(clearNode)} rust=${short(clearRust)}`
  );
  return ok;
}
