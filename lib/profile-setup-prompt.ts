export type ProfilePromptChoice = "activate" | "customise" | "disable" | null;

export type ProfilePromptPayload<T extends object> = T | null | undefined;

export function normaliseProfilePayload<T extends object>(
  profile: T
): T | null {
  return Object.values(profile).some((v) => typeof v === "string")
    ? profile
    : null;
}

export function resolveProfilePromptPayload<T extends object>(
  choice: ProfilePromptChoice,
  editedProfile: T,
  recommendedProfile: T
): ProfilePromptPayload<T> {
  if (choice === null) {
    return;
  }
  if (choice === "disable") {
    return null;
  }
  if (choice === "activate") {
    return normaliseProfilePayload(recommendedProfile);
  }
  return normaliseProfilePayload(editedProfile);
}
