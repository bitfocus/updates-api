import { Octokit } from "octokit";
import semver, { SemVer } from "semver";
import * as Sentry from "@sentry/node";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const {
  data: { login },
} = await octokit.rest.users.getAuthenticated();
console.log("Authenticated to Github as: %s", login);

export interface LatestReleases {
  currentStable: SemVer;
  oldStable: SemVer;
}

export async function fetchReleases() {
  const owner = "bitfocus";
  const repo = "companion";

  const releasesResponse = await octokit.rest.repos.listReleases({
    owner,
    repo,
    per_page: 25, // Should be enough for the latest couple of minor releases
  });

  const releases = releasesResponse.data;

  // ignore drafts and prereleases, and ignore any releases newer than 1 hour, to give them a gentler rollout
  const oneHourAgo = Date.now() - 1000 * 60 * 60;

  type VersionEntry = {
    sem: SemVer; // parsed SemVer
    raw: string; // original tag/name
  };

  const byMinor = new Map<string, VersionEntry>();

  for (const r of releases) {
    if (r.draft) continue;
    if (r.prerelease) continue;
    if (!r.published_at) continue;

    const publishedAt = new Date(r.published_at).getTime();
    if (isNaN(publishedAt)) continue;
    if (publishedAt > oneHourAgo) continue; // ignore releases newer than 1 hour

    // Prefer tag_name, then name
    const candidate = (r.tag_name || r.name || "").replace(/^v/, "");
    const coerced = semver.coerce(candidate, { loose: true })?.version;
    if (!coerced) continue;

    const parsed = semver.parse(coerced, { loose: true });
    if (!parsed) continue;

    const minorKey = `${parsed.major}.${parsed.minor}`;

    const existing = byMinor.get(minorKey);
    if (!existing) {
      byMinor.set(minorKey, { sem: parsed, raw: candidate });
    } else {
      // keep highest patch for this minor
      if (semver.gt(parsed, existing.sem)) {
        byMinor.set(minorKey, { sem: parsed, raw: candidate });
      }
    }
  }

  // produce array sorted by semver desc (highest version first)
  const sorted = Array.from(byMinor.values()).sort((a, b) =>
    semver.compare(b.sem, a.sem)
  );

  if (sorted.length === 0) {
    throw new Error("No suitable stable releases found");
  }

  // pick the highest as current
  const currentStable = sorted[0].sem;

  // pick the next entry with a different minor (major.minor)
  let oldStable: SemVer | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const candidate = sorted[i].sem;
    if (
      candidate.major !== currentStable.major ||
      candidate.minor !== currentStable.minor
    ) {
      oldStable = candidate;
      break;
    }
  }

  if (!oldStable) {
    oldStable = sorted[1].sem;
  }

  return {
    currentStable,
    oldStable,
  };
}

let latestReleases: LatestReleases | null = null;

export function getLatestReleases() {
  return latestReleases;
}

async function doUpdateLatestReleases() {
  return fetchReleases()
    .then((releases) => {
      latestReleases = releases;
      console.log(
        "Fetched latest releases: current=%s old=%s",
        releases.currentStable.version,
        releases.oldStable.version
      );
    })
    .catch((err) => {
      console.error("Error fetching latest releases:", err);
      Sentry.captureException(err, {});
    });
}

setInterval(() => {
  doUpdateLatestReleases();
}, 5 * 60 * 1000);

// Perform an initial fetch, before the app can start
await doUpdateLatestReleases();
