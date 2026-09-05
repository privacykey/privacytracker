import { execFileSync } from "node:child_process";
import { validateSigningEnvironment } from "./signing-environment.mjs";

const repo = process.env.GITHUB_REPOSITORY ?? "privacykey/privacytracker";
const api = (suffix) =>
  JSON.parse(
    execFileSync("gh", ["api", `repos/${repo}/${suffix}`], { encoding: "utf8" })
  );
const environment = api("environments/macos-signing");
const branches = api(
  "environments/macos-signing/deployment-branch-policies"
).branch_policies;
const count = validateSigningEnvironment(environment, branches);
console.log(
  `Signing approval gate verified (${count} reviewer entries; v* tags only).`
);
