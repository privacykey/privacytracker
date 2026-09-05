export function validateSigningEnvironment(environment, branches) {
  const reviewers =
    environment.protection_rules?.find(
      (rule) => rule.type === "required_reviewers"
    )?.reviewers ?? [];
  if (!reviewers.length) {
    throw new Error(
      "macos-signing has no required reviewer. A repository administrator must add a human user or team before signing."
    );
  }
  const policy = environment.deployment_branch_policy;
  if (!policy?.custom_branch_policies || policy.protected_branches) {
    throw new Error(
      "macos-signing must restrict deployments to selected release tags"
    );
  }

  if (
    branches.length !== 1 ||
    branches[0].type !== "tag" ||
    branches[0].name !== "v*"
  ) {
    throw new Error("macos-signing must allow only the v* tag policy");
  }

  return reviewers.length;
}
