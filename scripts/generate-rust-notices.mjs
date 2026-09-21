// Third-party notices for the Rust backend (Phase 6, batches 5b and 6b).
//
// The Node build's disclosures come from package.json, which /legal reads
// directly. The Rust build ships compiled crates instead, so the list has
// to be taken from cargo. Two binaries ship, each with its own list:
//
//   src-tauri/THIRD-PARTY-RUST.md   the desktop app: the shell built with
//                                   `--features rust-backend`, for one
//                                   macOS target. Staged into the bundle
//                                   beside NOTICE, LICENSE and
//                                   core/V8-LICENSE.
//   lib/rust-crates.json            a summary of that list /legal renders:
//                                   the licence breakdown and the crates we
//                                   chose ourselves. Small on purpose,
//                                   because a client component imports it.
//   core/THIRD-PARTY-RUST.md        the Docker image's server: the core
//                                   alone, for both Linux targets the
//                                   image is built for. Copied into the
//                                   image beside the same three notices.
//
// Each list names every crate that can end up in its binary, with
// version, licence and repository, and each is committed.
//
// Only NORMAL dependencies are walked. Build dependencies (syn, quote,
// proc-macro2 and friends) run at compile time and their code does not
// ship; dev dependencies are tests. Both are excluded, and the file says
// so, because a notice that quietly includes them reads as if it were the
// shipped set.
//
// Run: `pnpm notices:rust`. CI regenerates and diffs, so a dependency
// change that is not disclosed fails the build rather than shipping.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

/**
 * The two lists. Filtering to a target keeps crates for other platforms
 * (Windows-only ones, say) out of a list that claims to describe what
 * ships. One macOS target is enough for the desktop app, whose crate set is
 * the same on both architectures. The image is built for two Linux targets,
 * whose crate sets differ slightly (x86_64 links `cpufeatures`, which
 * aarch64 does not), so both are walked and a crate only some targets link
 * is marked with the ones that do.
 */
const LISTS = [
  {
    manifest: path.join(repo, "src-tauri", "Cargo.toml"),
    features: ["--no-default-features", "--features", "rust-backend"],
    targets: ["aarch64-apple-darwin"],
    out: path.join(repo, "src-tauri", "THIRD-PARTY-RUST.md"),
    what: "The desktop app built on the Rust backend",
    carrier: "app",
    summary: path.join(repo, "lib", "rust-crates.json"),
  },
  {
    manifest: path.join(repo, "core", "Cargo.toml"),
    features: [],
    targets: ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"],
    out: path.join(repo, "core", "THIRD-PARTY-RUST.md"),
    what: "The Docker image's server, `pt-core`,",
    carrier: "image",
  },
];

/** Ours, not third party. */
const OURS = new Set(["privacytracker", "privacytracker-core"]);

function metadata(list, target) {
  const json = execFileSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      list.manifest,
      ...list.features,
      "--filter-platform",
      target,
      "--format-version",
      "1",
      "--locked",
    ],
    { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return JSON.parse(json);
}

/** Every crate reachable from the root through normal dependencies. */
function shipped(meta) {
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const root = meta.resolve.root ?? meta.workspace_members[0];
  const seen = new Set();
  const queue = [root];
  while (queue.length > 0) {
    const id = queue.pop();
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      const normal = dep.dep_kinds.some((kind) => kind.kind === null);
      if (normal && !seen.has(dep.pkg)) {
        queue.push(dep.pkg);
      }
    }
  }
  return [...seen]
    .map((id) => byId.get(id))
    .filter((pkg) => pkg && !OURS.has(pkg.name))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
    );
}

/** The crates we picked ourselves: the shell's and the core's own
 *  dependency lists, which is what a reader wants named. */
function direct(meta) {
  const chosen = new Map();
  for (const pkg of meta.packages) {
    if (!OURS.has(pkg.name)) {
      continue;
    }
    for (const dep of pkg.dependencies) {
      if (dep.kind === "dev" || dep.kind === "build" || OURS.has(dep.name)) {
        continue;
      }
      chosen.set(dep.name, true);
    }
  }
  return chosen;
}

const identity = (crate) => `${crate.name}@${crate.version}`;

for (const list of LISTS) {
  const [target, ...others] = list.targets;
  const meta = metadata(list, target);
  // Every crate any of the targets links, and which targets link each, so
  // a crate only one architecture pulls in is listed and says so, rather
  // than one list silently describing both.
  const linkedOn = new Map();
  const byIdentity = new Map();
  for (const [t, crates] of [
    [target, shipped(meta)],
    ...others.map((other) => [other, shipped(metadata(list, other))]),
  ]) {
    for (const crate of crates) {
      byIdentity.set(identity(crate), crate);
      linkedOn.set(identity(crate), [
        ...(linkedOn.get(identity(crate)) ?? []),
        t,
      ]);
    }
  }
  const crates = [...byIdentity.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  );
  const only = (crate) => {
    const on = linkedOn.get(identity(crate));
    return on.length < list.targets.length ? ` (${on.join(", ")} only)` : "";
  };

  const licenses = {};
  for (const crate of crates) {
    const id = crate.license ?? "(not declared)";
    licenses[id] = (licenses[id] ?? 0) + 1;
  }

  const lines = [
    "# Third-party Rust crates",
    "",
    `${list.what} links the crates below. It is`,
    `generated by \`pnpm notices:rust\` from \`cargo metadata\` for ${list.targets.join(" and ")},`,
    "and CI fails if it is out of date.",
    ...(others.length > 0
      ? [
          "",
          "A crate that only some of those targets link is marked with the",
          "targets that do.",
        ]
      : []),
    "",
    "Only normal dependencies are listed: build dependencies run at compile",
    "time and their own code does not ship, and dev dependencies are tests.",
    "",
    `${crates.length} crates, by licence:`,
    "",
    ...Object.entries(licenses)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => `- ${id}: ${count}`),
    "",
    "| Crate | Version | Licence | Source |",
    "| --- | --- | --- | --- |",
    ...crates.map(
      (crate) =>
        `| ${crate.name}${only(crate)} | ${crate.version} | ${crate.license ?? "(not declared)"} | ${crate.repository ?? ""} |`
    ),
    "",
    `The ${list.carrier} also carries \`NOTICE\`, \`LICENSE\` and \`V8-LICENSE\`: the last covers`,
    "the ports of V8's date parser and JSON error messages in the core.",
    "",
  ];
  writeFileSync(list.out, `${lines.join("\n")}`);

  let chosenCount = null;
  if (list.summary) {
    const chosen = direct(meta);
    const summary = {
      // Regenerate with `pnpm notices:rust`; CI diffs it.
      target,
      crates: crates.length,
      licenses: Object.fromEntries(
        Object.entries(licenses).sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
        )
      ),
      direct: crates
        .filter((crate) => chosen.has(crate.name))
        .map((crate) => ({
          name: crate.name,
          version: crate.version,
          license: crate.license ?? "(not declared)",
          repository: crate.repository ?? null,
        })),
    };
    writeFileSync(list.summary, `${JSON.stringify(summary, null, 2)}\n`);
    chosenCount = summary.direct.length;
  }

  console.log(
    `notices: ${crates.length} crates${chosenCount === null ? "" : ` (${chosenCount} chosen directly)`} for ${list.targets.join(" and ")} -> ${path.relative(repo, list.out)}`
  );
}
