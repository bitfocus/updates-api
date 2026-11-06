import semver from "semver";
import type { LatestReleases } from "../src/lib/releases.js";

/**
 * Stand-in for src/lib/releases.ts, which queries GitHub at import time.
 * Use it in a test file with:
 *   vi.mock("../src/lib/releases.js", () => import("./releases-mock.js"));
 */
export const releasesState: {
  companion: LatestReleases | null;
  satellite: LatestReleases | null;
} = {
  companion: null,
  satellite: null,
};

export function getLatestReleases() {
  return releasesState.companion;
}

export function getLatestSatelliteReleases() {
  return releasesState.satellite;
}

export function makeReleases(
  currentStable: string,
  oldStable: string
): LatestReleases {
  return {
    currentStable: semver.parse(currentStable)!,
    oldStable: semver.parse(oldStable)!,
  };
}
