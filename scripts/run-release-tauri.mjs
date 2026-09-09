// tauri-action invokes this wrapper for build and version probes. Unset
// notarization credentials in rehearsals; the Apple signing cert stays available.
import { spawnSync } from "node:child_process";

const env = { ...process.env };
if (env.RELEASE_DRY_RUN === "1") {
  for (const key of [
    "APPLE_API_KEY",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_PATH",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    delete env[key];
  }
}
const result = spawnSync("pnpm", ["tauri", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
