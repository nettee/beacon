import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { Profile, ProfileSkills } from "../config/profile.js";

/** Fixed path: `~/.beacon/profiles/<id>/workspace` (no yaml override). */
export function profileWorkspaceDirectory(profileDirectory: string): string {
  return join(profileDirectory, "workspace");
}

export type EnsuredProfileWorkspace = {
  directory: string;
  /** Workspace-local skill paths for `--skill` (same order as Profile skills). */
  skillPaths: string[];
};

/**
 * Create the Profile workspace layout and refresh read-only mounts.
 * Does **not** create `repos/` — that is not a common workspace convention
 * (only amr-release may self-manage a checkout later).
 */
export async function ensureProfileWorkspace(
  profile: Pick<Profile, "directory" | "playbook" | "skills">,
): Promise<EnsuredProfileWorkspace> {
  const directory = profileWorkspaceDirectory(profile.directory);
  await mkdir(directory, { recursive: true });
  await mkdir(join(directory, "notes"), { recursive: true });
  await mkdir(join(directory, "tmp"), { recursive: true });

  await ensureSymlink(join(directory, "playbook"), profile.playbook);

  const skillPaths: string[] = [];
  if (profile.skills?.mode === "explicit" && profile.skills.paths.length > 0) {
    const skillsDir = join(directory, "skills");
    await mkdir(skillsDir, { recursive: true });
    for (const skillPath of profile.skills.paths) {
      const name = basename(skillPath);
      const linkPath = join(skillsDir, name);
      await ensureSymlink(linkPath, skillPath);
      skillPaths.push(linkPath);
    }
  }

  return { directory, skillPaths };
}

/** Remap Profile skills to workspace-local symlink paths when enabled. */
export function workspaceSkills(
  profile: Pick<Profile, "skills">,
  ensured: EnsuredProfileWorkspace,
): ProfileSkills | undefined {
  if (profile.skills?.mode !== "explicit") {
    return profile.skills;
  }
  return { mode: "explicit", paths: ensured.skillPaths };
}

async function ensureSymlink(linkPath: string, target: string): Promise<void> {
  const absoluteTarget = resolve(target);
  try {
    const existing = await lstat(linkPath);
    if (!existing.isSymbolicLink()) {
      throw new Error(
        `Profile workspace mount exists and is not a symlink: ${linkPath}`,
      );
    }
    const current = await readlink(linkPath);
    const currentAbsolute = resolve(dirname(linkPath), current);
    if (
      current === absoluteTarget ||
      currentAbsolute === absoluteTarget ||
      current === target
    ) {
      return;
    }
    await rm(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await symlink(absoluteTarget, linkPath);
}
