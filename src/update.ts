import { z, type APIServer } from "@bitfocusas/api";
import { PrismaClient } from "./prisma/client.js";
import semver from "semver";
import * as Sentry from "@sentry/node";
import { getLatestReleases } from "./lib/releases.js";

export const UpdatesBody = z.object({
  id: z.string().describe("Unique identifier for the installation"),
  app: z.object({
    name: z.string().describe("Name of the application"),
    version: z.string().describe("Current version of the application"),
    build: z.string().describe("Full build number or identifier"),
  }),
  os: z.object({
    platform: z.string().describe("Operating system platform"),
    arch: z.string().describe("System architecture"),
    release: z.string().describe("OS release version"),
  }),
});
export type UpdatesBodyType = z.infer<typeof UpdatesBody>;

const UpdatesResponse = z.object({
  ok: z
    .boolean()
    .describe(
      "Indicates if the check was successful, or should be retried later"
    ),
  message: z.string().describe("Update message"),
  link: z.string().url().optional().describe("Download URL"),
});
type UpdatesResponseType = z.infer<typeof UpdatesResponse>;

export function registerUpdateRoutes(
  app: APIServer,
  prisma: PrismaClient
): void {
  app.createEndpoint({
    method: "POST",
    url: "/updates",
    body: UpdatesBody,
    response: UpdatesResponse,
    config: {
      description: "Check if updates are available",
      tags: ["Updates"],
    },
    handler: async (request) => {
      // Defer database update to not block response
      updateUserDb(prisma, request.body).catch((error) => {
        console.error("Error updating user in database:", error);
        Sentry.captureException(error, { extra: { userInfo: request.body } });
      });

      if (request.body.app.name === "companion") {
        return prepareCompanionResponse(request.body.app.build);
      } else {
        return {
          ok: true,
          message: "",
          // message: "Unknown application",
        };
      }
    },
  });

  app.createEndpoint({
    method: "POST",
    url: "/updates-old",
    body: z.object({
      id: z.string().describe("Unique identifier for the installation"),

      app_name: z.enum(["companion"]).describe("Name of the application"),
      app_version: z.string().describe("Current version of the application"),
      app_build: z.string().describe("Full build number or identifier"),

      platform: z.string().describe("Operating system platform"),
      arch: z.string().describe("System architecture"),
      release: z.string().describe("OS release version"),

      tz: z.any().optional(),
      cpus: z.any().optional(),
      type: z.any().optional(),
    }),
    response: z.object({
      message: z.string().describe("Update message"),
      link: z.string().url().optional().describe("Download URL"),
    }),
    config: {
      description: "Check if updates are available (legacy endpoint)",
      tags: ["Updates"],
    },
    handler: async (request) => {
      // Defer database update to not block response
      updateUserDb(prisma, {
        id: request.body.id,
        app: {
          name: request.body.app_name,
          version: request.body.app_version,
          build: request.body.app_build,
        },
        os: {
          platform: request.body.platform,
          arch: request.body.arch,
          release: request.body.release,
        },
      }).catch((error) => {
        console.error("Error updating user in database:", error);
        Sentry.captureException(error, { extra: { userInfo: request.body } });
      });

      return prepareCompanionResponse(request.body.app_build);
    },
  });
}

async function prepareCompanionResponse(
  appBuild: string
): Promise<UpdatesResponseType> {
  const parsedBuild = semver.parse(appBuild, { loose: true });
  if (!parsedBuild) {
    return {
      ok: true,
      message: "Unable to check updates: Invalid version format",
    };
  }

  // Very old 2.x versions, interpreting stable vs beta is different and not worth supporting
  if (parsedBuild.major < 3) {
    return {
      ok: true,
      message:
        "This is a very old version of Companion. Companion has improved a lot, we strongly recommend updating",
      link: "https://bitfocus.io/companion?inapp_ancient",
    };
  }

  // Known build format must be like: 3.3.1+7001-stable-ee7c3daa
  // Accept optional leading `v`, require core semver, a `+` build number, then `-stable-<hash>` or `-beta-<hash>`
  const knownBuildMatch = appBuild.match(
    /^v?(\d+)\.(\d+)\.(\d+)\+(\d+)-(.+)-([0-9a-fA-F]{7,40})$/
  );
  if (!knownBuildMatch) {
    return {
      ok: true,
      message: "Unable to check updates: Unknown build format",
    };
  }

  const buildKind = knownBuildMatch[5];
  const isStable = buildKind === "stable";
  const isBeta = buildKind === "beta";

  // Make sure we know the latest releases
  const latestReleases = getLatestReleases();
  if (!latestReleases) {
    return {
      // Unable to check, encourage client to try again later
      ok: false,
      message: "",
    };
  }

  // If the user version is older than the minor branch of the old stable, we consider it outdated
  const oldStableMinorBranch = `${latestReleases.oldStable.major}.${latestReleases.oldStable.minor}.0`;
  // Don't consider beta/stable differences here, just the version number
  if (semver.lt(parsedBuild, oldStableMinorBranch, { loose: true })) {
    return {
      ok: true,
      message: `This version of Companion is outdated and no longer supported. Please update to the latest version v${latestReleases.currentStable}.`,
      link: "https://bitfocus.io/companion?inapp_obsolete",
    };
  }

  if (isStable) {
    // Cases handled for stable builds:
    // - User on old stable minor branch (major.minor == oldStable.major.minor)
    //   - If user < oldStable => behind old stable (offer update)
    //   - If user == oldStable => latest of old stable (offer update to current)
    // - User on current stable minor branch (major.minor == currentStable.major.minor)
    //   - If user == currentStable => no message
    //   - If user < currentStable => behind current (offer update)
    // Any other stable build (different minor) will fall through to the default assumption below.

    // Old stable branch
    if (
      parsedBuild.major === latestReleases.oldStable.major &&
      parsedBuild.minor === latestReleases.oldStable.minor
    ) {
      if (semver.lt(parsedBuild, latestReleases.oldStable, { loose: true })) {
        // Behind on the old stable branch
        // TODO - also report a newer oldstable?
        return {
          ok: true,
          message: `A new stable version (v${latestReleases.currentStable.version}) is available.`,
          link: "https://bitfocus.io/companion?inapp_stable",
        };
      }

      // userSem >= latestReleases.oldStable
      return {
        ok: true,
        message: `A new stable version (v${latestReleases.currentStable.version}) is available.`,
        link: "https://bitfocus.io/companion?inapp_stable",
      };
    }

    // Current stable branch
    if (
      parsedBuild.major === latestReleases.currentStable.major &&
      parsedBuild.minor === latestReleases.currentStable.minor
    ) {
      if (
        semver.eq(parsedBuild, latestReleases.currentStable, { loose: true })
      ) {
        return {
          ok: true,
          message: "",
        };
      }

      if (
        semver.lt(parsedBuild, latestReleases.currentStable, { loose: true })
      ) {
        return {
          ok: true,
          message: `A new stable version (v${latestReleases.currentStable.version}) is available.`,
          link: "https://bitfocus.io/companion?inapp_stable",
        };
      }

      // If userSem > currentStable (unexpected), fall through to default assumption below
    }
    // Default assumption for any other stable case: assume on current stable branch and not latest
    return {
      ok: true,
      message: `A new stable version (v${latestReleases.currentStable.version}) is available.`,
      link: "https://bitfocus.io/companion?inapp_stable",
    };
  } else if (isBeta) {
    // Beta

    return {
      ok: true,
      message: "Remember, this is a beta version!",
      link: "https://bitfocus.io/companion?inapp_beta",
    };
  } else {
    // Experimental

    return {
      ok: true,
      message:
        "EXPERIMENTAL: Thank you for testing these experimental features!",
      link: "https://bitfocus.io/companion?inapp_beyond",
    };
  }
}

async function updateUserDb(
  prisma: PrismaClient,
  userInfo: z.infer<typeof UpdatesBody>
): Promise<void> {
  await prisma.user.upsert({
    where: {
      user_id_app_name: {
        user_id: userInfo.id,
        app_name: userInfo.app.name,
      },
    },
    update: {
      app_version: userInfo.app.version,
      app_build: userInfo.app.build,

      os_platform: userInfo.os.platform,
      os_arch: userInfo.os.arch,
      os_release: userInfo.os.release,
    },
    create: {
      user_id: userInfo.id,

      app_name: userInfo.app.name,
      app_version: userInfo.app.version,
      app_build: userInfo.app.build,

      os_platform: userInfo.os.platform,
      os_arch: userInfo.os.arch,
      os_release: userInfo.os.release,
    },
  });
}
