// Stand-ins for gh, codesign and xcrun, so the release scripts can run end
// to end without GitHub or a signed macOS bundle. installFakeTools writes a
// small executable per tool that calls main() here.
//
// gh keeps its releases in the JSON file named by FAKE_GH_STATE:
//   { releases: { <tag>: { isDraft, body, assets: { <name>: <file> } } } }
// Every call of every tool is appended to CALL_LOG as a JSON array.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function installFakeTools(bin) {
  mkdirSync(bin, { recursive: true });
  const module = JSON.stringify(pathToFileURL(import.meta.filename).href);
  for (const tool of ["gh", "codesign", "xcrun"]) {
    writeFileSync(
      path.join(bin, tool),
      `#!/usr/bin/env node\nimport(${module}).then((fake) => fake.main(${JSON.stringify(tool)}));\n`,
      { mode: 0o755 }
    );
  }
}

export function readState(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeState(file, state) {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Puts `bytes` on release `tag` as asset `name`. */
export function putAsset(stateFile, tag, name, bytes) {
  const state = readState(stateFile);
  const file = storeFile(stateFile, name);
  writeFileSync(file, bytes);
  state.releases[tag].assets[name] = file;
  writeState(stateFile, state);
}

function storeFile(stateFile, name) {
  const store = path.join(path.dirname(stateFile), "store");
  mkdirSync(store, { recursive: true });
  let n = 0;
  while (existsSync(path.join(store, `${n}-${name}`))) {
    n++;
  }
  return path.join(store, `${n}-${name}`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function option(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      values.push(args[i + 1]);
    }
  }
  return values;
}

function gh(args) {
  const stateFile = process.env.FAKE_GH_STATE;
  const state = readState(stateFile);
  const [group, command, tag] = args;
  const release = state.releases[tag];
  if (group !== "release") {
    fail(`fake gh: unsupported ${args.join(" ")}`);
  }
  if (!release) {
    fail("release not found");
  }
  if (command === "view") {
    const [fields] = option(args, "--json");
    if (option(args, "--jq")[0] === ".body") {
      process.stdout.write(`${release.body}\n`);
      return;
    }
    const all = {
      isDraft: release.isDraft,
      body: release.body,
      assets: Object.entries(release.assets).map(([name, file]) => ({
        name,
        size: statSync(file).size,
      })),
    };
    const picked = Object.fromEntries(
      fields.split(",").map((field) => [field, all[field]])
    );
    process.stdout.write(`${JSON.stringify(picked)}\n`);
    return;
  }
  if (command === "download") {
    const dir = option(args, "--dir")[0] ?? ".";
    mkdirSync(dir, { recursive: true });
    let matched = 0;
    for (const pattern of option(args, "--pattern")) {
      const file = release.assets[pattern];
      if (!file) {
        continue;
      }
      const target = path.join(dir, pattern);
      if (existsSync(target) && !args.includes("--clobber")) {
        fail(`${target} already exists`);
      }
      copyFileSync(file, target);
      // A stand-in for bytes changed in transit or at rest.
      if (process.env.FAKE_GH_CORRUPT_DOWNLOAD === pattern) {
        appendFileSync(target, "corrupted");
      }
      matched++;
    }
    if (matched === 0) {
      fail("no assets match the file pattern");
    }
    return;
  }
  if (command === "upload") {
    for (const file of args.slice(3).filter((arg) => !arg.startsWith("--"))) {
      const name = path.basename(file);
      if (release.assets[name] && !args.includes("--clobber")) {
        fail(`asset ${name} already exists`);
      }
      const stored = storeFile(stateFile, name);
      copyFileSync(file, stored);
      release.assets[name] = stored;
    }
    writeState(stateFile, state);
    return;
  }
  if (command === "delete-asset") {
    const name = args[3];
    if (!release.assets[name]) {
      fail(`asset ${name} not found`);
    }
    delete release.assets[name];
    writeState(stateFile, state);
    return;
  }
  fail(`fake gh: unsupported ${args.join(" ")}`);
}

function codesign(args) {
  const bundle = args.at(-1);
  const executable = path.join(bundle, "Contents/MacOS/privacytracker");
  if (!existsSync(executable)) {
    fail(`${bundle}: code object is not signed at all`);
  }
  if (args[0] === "--verify") {
    return;
  }
  if (args[0] === "--display") {
    let hash = createHash("sha256")
      .update(readFileSync(executable))
      .digest("hex")
      .slice(0, 40);
    // Stands in for an unpacked copy that is not the verified app.
    if (
      process.env.FAKE_CDHASH_MISMATCH === "1" &&
      bundle.includes("privacytracker-updater-")
    ) {
      hash = "0".repeat(40);
    }
    process.stderr.write(`Executable=${executable}\nCDHash=${hash}\n`);
    return;
  }
  fail(`fake codesign: unsupported ${args.join(" ")}`);
}

export function main(tool) {
  const args = process.argv.slice(2);
  if (process.env.CALL_LOG) {
    appendFileSync(
      process.env.CALL_LOG,
      `${JSON.stringify([tool, ...args])}\n`
    );
  }
  if (tool === "gh") {
    gh(args);
  } else if (tool === "codesign") {
    codesign(args);
  } else if (tool !== "xcrun") {
    fail(`unknown fake tool ${tool}`);
  }
}
