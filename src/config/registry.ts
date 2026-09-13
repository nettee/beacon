import { readdir } from "node:fs/promises";

import { loadProfile, type Profile } from "./profile.js";

export async function loadProfileRegistry(
  profilesDirectory: string,
): Promise<Profile[]> {
  const entries = await readdir(profilesDirectory, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (ids.length === 0)
    throw new Error(`No Profiles found in ${profilesDirectory}`);
  return Promise.all(ids.map((id) => loadProfile(id, profilesDirectory)));
}
