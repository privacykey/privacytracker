// Where a Docker build is published, and under which tags.
//
// Only a release tag (v<version>) publishes to the public package,
// ghcr.io/<owner>/<repo>: the version, and for a final release also
// <major>.<minor> and `latest`, so `latest` always names the newest release
// and never a prerelease. Every other build (a push to main) publishes to
// the private package ghcr.io/<owner>/<repo>-edge, tagged `edge` and
// sha-<commit>, as pull request previews do (pr-preview.yml). GHCR sets
// visibility per package, not per tag, which is why builds that were never
// released need a package of their own.
//
// Run by .github/workflows/docker-publish.yml, it reads the GITHUB_*
// variables and writes `channel`, `image`, `latest` and `tags` (lines for
// docker/metadata-action) to GITHUB_OUTPUT.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readReleaseMetadata,
  validateReleaseTag,
  validateVersion,
} from "./release-metadata.mjs";

const REPOSITORY = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

export function dockerPublishTarget({ repository, refType, refName, sha }) {
  const repo = String(repository).toLowerCase();
  if (!REPOSITORY.test(repo)) {
    throw new Error(`Unexpected repository name: ${repository}`);
  }
  if (refType === "tag") {
    if (!refName?.startsWith("v")) {
      throw new Error(`Refusing to publish tag ${refName}: not a release tag`);
    }
    const version = validateVersion(refName.slice(1));
    const prerelease = version.includes("-");
    const [major, minor] = version.split(".");
    return {
      channel: "release",
      image: `ghcr.io/${repo}`,
      version,
      latest: !prerelease,
      tags: prerelease ? [version] : [version, `${major}.${minor}`, "latest"],
    };
  }
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) {
    throw new Error("Expected the full commit SHA");
  }
  return {
    channel: "edge",
    image: `ghcr.io/${repo}-edge`,
    version: null,
    latest: false,
    tags: ["edge", `sha-${sha}`],
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const env = process.env;
  const target = dockerPublishTarget({
    repository: env.GITHUB_REPOSITORY,
    refType: env.GITHUB_REF_TYPE,
    refName: env.GITHUB_REF_NAME,
    sha: env.GITHUB_SHA,
  });
  if (target.channel === "release") {
    // The public image carries the version the tagged commit declares.
    validateReleaseTag(env.GITHUB_REF_NAME, readReleaseMetadata(process.cwd()));
  }
  console.log(JSON.stringify(target));
  if (env.GITHUB_OUTPUT) {
    const rules = target.tags.map((tag) => `type=raw,value=${tag}`).join("\n");
    appendFileSync(
      env.GITHUB_OUTPUT,
      `channel=${target.channel}\nimage=${target.image}\nlatest=${target.latest}\ntags<<DOCKER_TAGS_END\n${rules}\nDOCKER_TAGS_END\n`
    );
  }
}
