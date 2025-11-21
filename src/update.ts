import { ValidationError, z, type APIServer } from "@bitfocusas/api";
import { PrismaClient } from "./prisma/client.js";
import Debug from "debug";

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

      return {
        message: "TEST",
      };
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
