import { z, type APIServer } from "@bitfocusas/api";
import { PrismaClient } from "./prisma/client.js";
import { BitfocusApi } from "./lib/bitfocus-api.js";
import semver from "semver";

const UpdatesBody = z.object({
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

const UpdatesResponse = z.object({
  message: z.string().describe("Update message"),
  link: z.string().url().optional().describe("Download URL"),
});

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
      description: "Check if updaes are available",
      tags: ["Updates"],
    },
    handler: async (request) => {
      // Defer database update to not block response
      updateUserDb(prisma, request.body).catch((error) => {
        console.error("Error updating user in database:", error);
      });

      if (request.headers["FROM-OLD-SERVER"]) {
        // This is from the old server, so we can skip the actual update check
        return {
          message: "",
        };
      }

      try {
        // Future: should this scrape github releases instead?
        // For now, use Bitfocus API to get product metadata
        const productResponse = await BitfocusApi.GET("/product");
        if (productResponse.error) {
          throw new Error(
            `Failed to fetch product data: ${productResponse.error}`
          );
        } else if (!productResponse.data) {
          throw new Error("No product data received from Bitfocus API");
        }

        // @ts-expect-error TODO: missing types
        const product = (productResponse.data as any[]).find(
          (p) => p.id === "prod_JfHsRVktrUs8pp"
        );

        if (!product) throw new Error("Product not found");

        interface PackageInfo {
          version: string;
          build: string;
        }

        const stables: PackageInfo[] = [];
        const betas: PackageInfo[] = [];
        const experimentals: PackageInfo[] = [];

        // go through all metadata
        const metadataKeys = Object.keys(product.metadata);
        for (let i = 0; i < metadataKeys.length; i++) {
          const key = metadataKeys[i];
          const value = product.metadata[key];
          if (key.startsWith("package:")) {
            const [_, type, _platform] = key.split(":");
            const parsedValue = JSON.parse(value);
            const build = parsedValue.version.replace(/^v/, "");
            const version = semver.coerce(build)?.version;
            if (!version) continue;

            if (type === "stable") {
              stables.push({ version, build });
            } else if (type === "experimental") {
              experimentals.push({ version, build });
            } else if (type === "beta") {
              betas.push({ version, build });
            } else {
              console.log("unknown package type:", type);
            }
          }
        }

        const latestStableAvailable = stables.sort((a, b) =>
          semver.compare(b.version, a.version)
        )[0].build;
        const latestBetaAvailable = betas.sort((a, b) =>
          semver.compare(b.version, a.version)
        )[0].build;
        const latestExperimentalAvailable = experimentals.sort((a, b) =>
          semver.compare(b.version, a.version)
        )[0].build;

        const currentlyInstalled = request.body.app.build;

        if (semver.eq(latestStableAvailable, currentlyInstalled)) {
          // running latest, no message.
          return {
            message: "",
          };
        } else if (latestBetaAvailable === currentlyInstalled) {
          return {
            message: "Remember, this is a beta version!",
            link: "https://bitfocus.io/companion?inapp_beta",
          };
        } else if (semver.eq(latestBetaAvailable, currentlyInstalled)) {
          return {
            message: "This is not the current beta version available",
            link: "https://bitfocus.io/companion?inapp_beta",
          };
        } else if (semver.eq(latestExperimentalAvailable, currentlyInstalled)) {
          return {
            message: "EXPERIMENTAL",
            link: "https://bitfocus.io/companion?inapp_experimental",
          };
        } else if (semver.gt(latestStableAvailable, currentlyInstalled)) {
          return {
            message:
              "A new stable version (" +
              latestStableAvailable +
              ") is available",
            link: "https://bitfocus.io/companion?inapp_stable",
          };
        } else if (semver.gt(latestBetaAvailable, currentlyInstalled)) {
          return {
            message:
              "A new beta version (" + latestBetaAvailable + ") is available",
            link: "https://bitfocus.io/companion?inapp_beta",
          };
        } else {
          return {
            message: "EXPERIMENTAL BUILD: Do not use in production",
            link: "https://bitfocus.io/companion?inapp_beyond",
          };
        }
      } catch (error) {
        console.error("Failed to fetch updates data:", error);
        throw new Error("Could not fetch updates information at this time.");
      }
    },
  });
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
