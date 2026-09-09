#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";

import { validateSigningEnvironment } from "./signing-environment.mjs";

const expectedChecks = ["quality", "rust-check", "container-smoke"];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function ghAvailable() {
  const result = spawnSync("gh", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function ghJson(args) {
  const out = run("gh", ["api", ...args]);
  return out ? JSON.parse(out) : null;
}

function parseRepoFromGit() {
  try {
    const remote = run("git", ["config", "--get", "remote.origin.url"]);
    const match =
      remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/) ||
      remote.match(/^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function resolveRepo() {
  const fromArg = process.argv.find((arg) => arg.startsWith("--repo="));
  if (fromArg) {
    return fromArg.slice("--repo=".length);
  }
  return process.env.GITHUB_REPOSITORY || parseRepoFromGit();
}

function line(ok, label, detail = "") {
  const marker = ok ? "[ok]" : "[check]";
  console.log(`${marker} ${label}${detail ? ` - ${detail}` : ""}`);
}

function endpoint(path) {
  try {
    return { ok: true, data: ghJson([path]) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const strict = process.argv.includes("--strict");

if (!ghAvailable()) {
  fail("GitHub CLI (gh) is required for this read-only repo-settings audit.");
}

const repo = resolveRepo();
if (!repo) {
  fail("Could not resolve GitHub repository. Pass --repo=owner/name.");
}

const failures = [];
const note = (ok, label, detail) => {
  line(ok, label, detail);
  if (!ok) {
    failures.push(label);
  }
};

console.log(`Repository settings audit for ${repo}`);
console.log("");

const repoResult = endpoint(`repos/${repo}`);
if (!repoResult.ok) {
  fail(
    `Could not read repo metadata for ${repo}. Is gh authenticated with repo admin/read access?`
  );
}

const repoData = repoResult.data;
const security = repoData.security_and_analysis ?? {};
note(
  repoData.visibility === "public" || repoData.private === true,
  "Repository metadata readable"
);
note(
  repoData.has_issues === true,
  "Issues enabled",
  "needed for security and live-check triage"
);
// Renovate owns dependency update PRs; Dependabot alerts are checked below.
note(
  security.secret_scanning?.status === "enabled",
  "Secret scanning enabled",
  security.secret_scanning?.status ??
    "status unavailable; an administrator must verify"
);
note(
  security.secret_scanning_push_protection?.status === "enabled",
  "Secret scanning push protection enabled",
  security.secret_scanning_push_protection?.status ??
    "status unavailable; an administrator must verify"
);

const rules = endpoint(`repos/${repo}/rules/branches/main`);
const protection =
  rules.ok && rules.data.length > 0
    ? null
    : endpoint(`repos/${repo}/branches/main/protection`);
if (rules.ok && rules.data.length > 0) {
  const has = (type) => rules.data.some((rule) => rule.type === type);
  const pr = rules.data.find((rule) => rule.type === "pull_request");
  const contexts = rules.data
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) =>
      rule.parameters.required_status_checks.map((check) => check.context)
    );
  note(
    (pr?.parameters.required_approving_review_count ?? 0) >= 1,
    "Pull request approval required on main"
  );
  note(has("non_fast_forward"), "Force pushes disabled on main");
  note(has("deletion"), "Branch deletion disabled on main");
  note(has("required_signatures"), "Signed commits required on main");
  const missing = expectedChecks.filter((check) => !contexts.includes(check));
  note(
    missing.length === 0,
    "Expected required CI checks configured",
    missing.length ? `missing: ${missing.join(", ")}` : contexts.join(", ")
  );
} else if (protection?.ok) {
  const data = protection.data;
  const contexts = data.required_status_checks?.contexts ?? [];
  const missingChecks = expectedChecks.filter(
    (check) => !contexts.some((context) => context.includes(check))
  );
  note(
    Boolean(data.required_pull_request_reviews),
    "Pull request review rule enabled"
  );
  note(
    data.enforce_admins?.enabled === true,
    "Branch protection applies to admins"
  );
  note(
    data.allow_force_pushes?.enabled === false,
    "Force pushes disabled on main"
  );
  note(
    data.allow_deletions?.enabled === false,
    "Branch deletion disabled on main"
  );
  note(
    missingChecks.length === 0,
    "Expected required CI checks configured",
    missingChecks.length
      ? `missing: ${missingChecks.join(", ")}`
      : `${contexts.length} contexts`
  );
} else {
  note(
    false,
    "main branch protection readable/enabled",
    "enable branch protection for main"
  );
}

const signing = endpoint(`repos/${repo}/environments/macos-signing`);
const signingTags = endpoint(
  `repos/${repo}/environments/macos-signing/deployment-branch-policies`
);
try {
  if (!(signing.ok && signingTags.ok)) {
    throw new Error("Cannot read signing environment protections");
  }
  validateSigningEnvironment(signing.data, signingTags.data.branch_policies);
  note(true, "Signing requires reviewer approval and v* tags");
} catch (error) {
  note(false, "Signing approval gate", error.message);
}

const codeScanning = endpoint(`repos/${repo}/code-scanning/alerts?per_page=1`);
note(
  codeScanning.ok,
  "Code scanning alerts API readable",
  codeScanning.ok
    ? "CodeQL is enabled or accessible"
    : "enable CodeQL/code scanning"
);

const dependabotAlerts = endpoint(`repos/${repo}/dependabot/alerts?per_page=1`);
note(
  dependabotAlerts.ok,
  "Dependabot alerts API readable",
  dependabotAlerts.ok
    ? "Dependabot alerts enabled or accessible"
    : "enable Dependabot alerts"
);

const secretAlerts = endpoint(
  `repos/${repo}/secret-scanning/alerts?per_page=1`
);
note(
  secretAlerts.ok,
  "Secret-scanning alerts API readable",
  secretAlerts.ok
    ? "secret scanning enabled or accessible"
    : "enable secret scanning"
);

console.log("");
console.log(
  `Audit complete: ${failures.length === 0 ? "all checked settings look good" : `${failures.length} setting(s) need attention`}.`
);
console.log(`Mode: ${strict ? "strict" : "advisory"}`);

if (strict && failures.length > 0) {
  process.exit(1);
}
