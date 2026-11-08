import { repositoryUrl } from "./git-cli.mjs";

// The same rules apply at startup and when the setup UI installs a profile into
// the running service, so a profile list accepted here also boots after restart.
export function validateSyncProfiles(profiles, transports = {}) {
  const profileIds = new Set(),
    resources = new Map();
  for (const profile of profiles) {
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(profile.profileId) ||
      profileIds.has(profile.profileId)
    )
      throw new Error("Duplicate or invalid synchronization profile");
    profileIds.add(profile.profileId);
    if (
      profile.replaces &&
      !profiles.some(
        (old) =>
          old.profileId === profile.replaces &&
          old.teamId === profile.teamId &&
          old.profileId !== profile.profileId,
      )
    )
      throw new Error("Replacement profile identity mismatch");
    if (
      profiles.filter(
        (other) => other.teamId === profile.teamId && !other.replaces,
      ).length !== 1
    )
      throw new Error("A team requires exactly one original resource profile");
    const repository =
      transports?.[profile.profileId]?.repository ||
      repositoryUrl(profile.repository);
    if (
      resources.has(repository) &&
      resources.get(repository) !== profile.teamId
    )
      throw new Error("One data repository cannot belong to multiple teams");
    resources.set(repository, profile.teamId);
  }
}
