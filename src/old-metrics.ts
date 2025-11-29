import { z, type APIServer } from "@bitfocusas/api";
import { PrismaClient } from "./prisma/client.js";
import * as Sentry from "@sentry/node";
import {
  DetailedUsageConnectionType,
  DetailedUsageSurfaceType,
} from "./detailed-usage.js";
import { writeSurfacesUsage } from "./lib/write-surfaces-usage.js";
import { writeConnectionsUsage } from "./lib/write-connections-usage.js";

const OldMetricsResponse = z.object({
  ok: z.boolean().describe("Indicates if the report was received successfully"),
});

export function registerOldMetricsRoutes(
  app: APIServer,
  prisma: PrismaClient
): void {
  app.createEndpoint({
    method: "POST",
    url: "/companion/old-metrics",
    body: z.any(), // No validation, as the structure is not very well defined :(
    response: OldMetricsResponse,
    config: {
      description: "Legacy Api endpoint for detailed usage information",
      tags: ["Usage"],
    },
    handler: async (request) => {
      try {
        const { i, r, m, mv, d, s } = request.body;

        if (!i || typeof i !== "string") {
          // Missing identifier
          return { ok: false };
        }

        const surfaces: DetailedUsageSurfaceType[] = [];
        const connections: DetailedUsageConnectionType[] = [];

        if (s) {
          try {
            /* 
              Record<
                string,
                {
                  type: string | undefined
                  description: string | undefined
                }
              >
            */
            for (const [serial, info] of Object.entries<any>(s)) {
              if (!serial || !info) continue;

              surfaces.push({
                id: String(serial),
                moduleId: String(info.type) || "unknown",
                description: String(info.description) || "Unknown",
              });
            }
          } catch (e) {
            Sentry.captureException(e, { extra: { surfacesPayload: s } });
          }
        } else if (d) {
          try {
            // Should be an array of string hashes
            for (const hash of d) {
              if (!hash) continue;

              surfaces.push({
                id: String(hash),
                moduleId: "legacy",
                description: "Unknown",
              });
            }
          } catch (e) {
            Sentry.captureException(e, { extra: { surfacesOldPayload: d } });
          }
        }

        if (mv) {
          try {
            // Record<string, Record<string, number>>
            for (const [moduleId, counts] of Object.entries<any>(mv)) {
              if (!moduleId || !counts) continue;

              const safeCounts: Record<string, number> = {};
              for (const [version, count] of Object.entries<any>(counts)) {
                const safeCount: number | undefined = Number(count);
                if (isNaN(safeCount) || safeCount < 0) continue;

                safeCounts[String(version)] = safeCount;
              }

              connections.push({
                moduleId: String(moduleId),
                counts: safeCounts,
              });
            }
          } catch (e) {
            Sentry.captureException(e, {
              extra: { moduleVersionsPayload: mv },
            });
          }
        } else if (m) {
          try {
            // Record<string, number>
            for (const [moduleId, count] of Object.entries<any>(m)) {
              if (!moduleId || !count) continue;

              const safeCount = Number(count);
              if (isNaN(safeCount) || safeCount < 0) continue;

              connections.push({
                moduleId: String(moduleId),
                counts: {
                  unknown: safeCount,
                },
              });
            }
          } catch (e) {
            Sentry.captureException(e, { extra: { modulesPayload: m } });
          }
        }

        let ok = true; // Track if anything errored that should tell the client to retry

        // Write tracked data
        await Promise.all([
          // clearOtherUsageData(prisma, i),
          writeSurfacesUsage(prisma, i, surfaces).then(
            (thisOk) => {
              if (!thisOk) ok = false;
            },
            (err) => {
              ok = false;
              Sentry.captureException(err, {
                extra: { machineId: i, surfaces },
              });
            }
          ),
          writeConnectionsUsage(prisma, i, connections).then(
            (thisOk) => {
              if (!thisOk) ok = false;
            },
            (err) => {
              ok = false;
              Sentry.captureException(err, {
                extra: { machineId: i, connections },
              });
            }
          ),
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
