const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(version, label = "version") {
  if (typeof version !== "string") {
    throw new Error(`${label} must be a string`);
  }

  const match = EXACT_SEMVER.exec(version);
  if (!match) {
    throw new Error(
      `Invalid ${label} ${JSON.stringify(version)}; expected exact major.minor.patch SemVer`,
    );
  }

  return match.slice(1).map((part) => {
    const value = Number.parseInt(part, 10);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${label} contains an unsafe integer component`);
    }
    return value;
  });
}

export function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion, "left version");
  const right = parseVersion(rightVersion, "right version");

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

export function bumpVersion(version, release) {
  const [major, minor, patch] = parseVersion(version);

  switch (release) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(
        `Invalid release type ${JSON.stringify(release)}; expected major, minor, or patch`,
      );
  }
}
