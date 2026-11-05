import { z, type APIServer } from "@bitfocusas/api";
import { PrismaClient } from "./prisma/client.js";
import { UpdatesBody } from "./update.js";
import * as Sentry from "@sentry/node";
import { writeModulesUsage } from "./lib/write-modules-usage.js";
import {
  writeSatelliteFeatures,
  writeSatellitePluginsUsage,
} from "./lib/write-satellite-usage.js";

const SatelliteUsagePlugin = z.object({
  moduleId: z
    .string()
    .describe("Id of the surface plugin (eg elgato-stream-deck, loupedeck)"),
  version: z.string().describe("Installed version of the surface plugin"),
  enabled: z.boolean().describe("Whether the surface plugin is enabled"),
  connectedSurfaces: z
    .number()
    .int()
    .nonnegative()
    .describe("Number of surfaces currently opened by the plugin"),
});

const SatelliteUsageFeatures = z
  .object({
    // Strings rather than enums, so that a new value doesn't cause the whole report to be rejected
    distribution: z
      .string()
      .describe("How satellite is being run (eg electron, headless, pi)"),
    remoteProtocol: z
      .string()
      .describe("Protocol used to connect to Companion (eg tcp, ws)"),

    connected: z
      .boolean()
      .describe("Whether satellite is currently connected to Companion"),
    companionVersion: z
      .string()
      .describe("Version of the connected Companion")
      .optional(),
    companionApiVersion: z
      .string()
      .describe("Satellite API version of the connected Companion")
      .optional(),

    restEnabled: z.boolean().describe("Indicates if the HTTP API is enabled"),
    mdnsEnabled: z
      .boolean()
      .describe("Indicates if mDNS announcements are enabled"),

    // Note: new fields MUST be optional, to avoid breaking reporting from older clients
  })
  .describe("Feature usage details");

// Make sure anything new gets set as optional, to not break reporting from older versions!
export const SatelliteUsageBody = UpdatesBody.extend({
  uptime: z.number().describe("Uptime of the application in seconds"),

  surfacePlugins: z
    .array(SatelliteUsagePlugin)
    .describe("List of installed surface plugins"),

  features: SatelliteUsageFeatures,
});

export type SatelliteUsagePluginType = z.infer<typeof SatelliteUsagePlugin>;
export type SatelliteUsageFeaturesType = z.infer<typeof SatelliteUsageFeatures>;

const SatelliteUsageResponse = z.object({
  ok: z.boolean().describe("Indicates if the report was received successfully"),
});

export function registerSatelliteUsageRoutes(
  app: APIServer,
  prisma: PrismaClient
): void {
  app.createEndpoint({
    method: "POST",
    url: "/satellite/detailed-usage",
    body: SatelliteUsageBody,
    response: SatelliteUsageResponse,
    config: {
      description: "Report detailed usage information from Satellite",
      tags: ["Usage"],
    },
    handler: async (request) => {
      try {
        const { id, app, os, surfacePlugins, features } = request.body;

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

        // Enabled plugins count as an install of the surface module, the same as in Companion
        const surfaceModules = surfacePlugins
          .filter((plugin) => plugin.enabled)
          .map((plugin) => ({
            moduleId: plugin.moduleId,
            counts: { [plugin.version]: 1 },
          }));

        await Promise.all([
          catchErrors(writeSatelliteFeatures(prisma, id, app, os, features), {
            features,
          }),
          catchErrors(writeSatellitePluginsUsage(prisma, id, surfacePlugins), {
            surfacePlugins,
          }),
          catchErrors(writeModulesUsage(prisma, id, [], surfaceModules), {
            surfaceModules,
          }),
        ]);

        return {
          ok,
        };
      } catch (error) {
        console.error("Error updating satellite usage stats in database:", error);
        Sentry.captureException(error, { extra: { userInfo: request.body } });
        return {
          ok: false,
        };
      }
    },
  });
}
