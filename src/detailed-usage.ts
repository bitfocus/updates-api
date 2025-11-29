import { z, type APIServer } from "@bitfocusas/api";
import { PrismaClient } from "./prisma/client.js";
import { UpdatesBody } from "./update.js";
import * as Sentry from "@sentry/node";
import { writeConnectionsUsage } from "./lib/write-connections-usage.js";
import { writeSurfacesUsage } from "./lib/write-surfaces-usage.js";
import { writeFeatureUsageData } from "./lib/write-features-usage.js";

const DetailedUsageSurface = z.object({
  moduleId: z
    .string()
    .describe("Type of surface module used (eg elgato-stream-deck, loupedeck"),
  id: z
    .string()
    .describe("Unique identifier for the surface (eg serial number)"),
  description: z
    .string()
    .describe("Human-readable description of the surface (eg Stream Deck XL)"),
  // lastUsed: z.number().optional().describe("Timestamp of when the surface was last used"),
});
const DetailedUsageConnection = z.object({
  moduleId: z
    .string()
    .describe("Type of connection module used (eg bmd-atem, studiocoast-vmix)"),
  counts: z
    .record(z.string(), z.number())
    .describe("Map of connection versions to count of instances"),
});

const DetailedUsageFeatures = z
  // General feature flags
  .object({
    isBoundToLoopback: z
      .boolean()
      .describe("Indicates if the server is bound to loopback only"),
    hasAdminPassword: z
      .boolean()
      .describe("Indicates if an admin password is set"),
    hasPincodeLockout: z
      .boolean()
      .describe("Indicates if pincode lockout is enabled"),
    cloudEnabled: z
      .boolean()
      .describe("Indicates if cloud features are enabled"),
    httpsEnabled: z.boolean().describe("Indicates if HTTPS is enabled"),

    // Protocol usage
    tcpEnabled: z.boolean().describe("Indicates if TCP protocol is enabled"),
    tcpDeprecatedEnabled: z
      .boolean()
      .describe("Indicates if deprecated TCP protocol is enabled"),
    udpEnabled: z.boolean().describe("Indicates if UDP protocol is enabled"),
    udpDeprecatedEnabled: z
      .boolean()
      .describe("Indicates if deprecated UDP protocol is enabled"),
    oscEnabled: z.boolean().describe("Indicates if OSC protocol is enabled"),
    oscDeprecatedEnabled: z
      .boolean()
      .describe("Indicates if deprecated OSC protocol is enabled"),
    rossTalkEnabled: z
      .boolean()
      .describe("Indicates if RossTalk protocol is enabled"),
    emberPlusEnabled: z
      .boolean()
      .describe("Indicates if Ember+ protocol is enabled"),
    artnetEnabled: z
      .boolean()
      .describe("Indicates if Art-Net protocol is enabled"),

    // Usage counts, to get an idea of scale
    connectionCount: z
      .number()
      .describe("Number of active connections configured"),
    pageCount: z.number().describe("Number of pages configured"),
    buttonCount: z.number().describe("Number of buttons configured"),
    triggerCount: z.number().describe("Number of triggers configured"),
    surfaceGroupCount: z
      .number()
      .describe("Number of surface groups configured"),
    customVariableCount: z
      .number()
      .describe("Number of custom variables configured"),
    expressionVariableCount: z
      .number()
      .describe("Number of expression variables configured"),

    gridSize: z
      .object({
        minCol: z.number().describe("Minimum grid column used"),
        maxCol: z.number().describe("Maximum grid column used"),
        minRow: z.number().describe("Minimum grid row used"),
        maxRow: z.number().describe("Maximum grid row used"),
      })
      .describe("Grid size details"),

    connectedSatellites: z
      .number()
      .describe("Number of connected satellite clients"),
  })
  .describe("Feature usage details");

// Make sure anything new gets set as optional, to not break reporting from older versions!
export const DetailedUsageBody = UpdatesBody.extend({
  uptime: z.number().describe("Uptime of the application in seconds"),

  surfaces: z.array(DetailedUsageSurface).describe("List of setup surfaces"),
  connections: z
    .array(DetailedUsageConnection)
    .describe("List of setup connections"),

  features: DetailedUsageFeatures,
});

export type DetailedUsageSurfaceType = z.infer<typeof DetailedUsageSurface>;
export type DetailedUsageConnectionType = z.infer<
  typeof DetailedUsageConnection
>;
export type DetailedUsageFeaturesType = z.infer<typeof DetailedUsageFeatures>;
export type DetailedUsageBodyType = z.infer<typeof DetailedUsageBody>;

const DetailedUsageResponse = z.object({
  ok: z.boolean().describe("Indicates if the report was received successfully"),
});

export function registerDetailedUsageRoutes(
  app: APIServer,
  prisma: PrismaClient
): void {
  app.createEndpoint({
    method: "POST",
    url: "/companion/detailed-usage",
    body: DetailedUsageBody,
    response: DetailedUsageResponse,
    config: {
      description: "Report detailed usage information",
      tags: ["Usage"],
    },
    handler: async (request) => {
      try {
        const { id, app, os, surfaces, connections, features } = request.body;

        let ok = true; // Track if anything errored that should tell the client to retry
        const catchErrors = async (
          res: Promise<boolean>,
          extra: Record<string, unknown>
        ) => {
          await res.then(
            (thisOk) => {
              if (!thisOk) ok = false;
            },
            (err) => {
              ok = false;
              Sentry.captureException(err, {
                extra: { machineId: id, ...extra },
              });
            }
          );
        };

        await Promise.all([
          catchErrors(writeFeatureUsageData(prisma, id, app, os, features), {
            features,
          }),
          catchErrors(writeSurfacesUsage(prisma, id, surfaces), { surfaces }),
          catchErrors(writeConnectionsUsage(prisma, id, connections), {
            connections,
          }),
        ]);

        return {
          ok,
        };
      } catch (error) {
        console.error("Error updating usage stats in database:", error);
        Sentry.captureException(error, { extra: { userInfo: request.body } });
        return {
          ok: false,
        };
      }
    },
  });
}
