import { APIServer, type APIServerConfig } from "@bitfocusas/api";
import type { PrismaClient } from "./prisma/client.js";
import { registerUpdateRoutes } from "./update.js";
import { registerDetailedUsageRoutes } from "./detailed-usage.js";
import { registerOldMetricsRoutes } from "./old-metrics.js";
import { registerSatelliteUsageRoutes } from "./satellite-usage.js";

export function createApp(
  prisma: PrismaClient,
  config: APIServerConfig<undefined> = {}
): APIServer {
  const app = new APIServer({
    apiTitle: "Companion Update API",
    apiDescription: "Companion Update API",
    // apiTags: [{ name: "Users", description: "User management endpoints" }],
    ...config,
  });

  // Redirect the root path to the Companion website
  app.instance.get("/", (_request, reply) => {
    reply.redirect("https://companion.free");
  });

  // Register routes
  registerUpdateRoutes(app, prisma);
  registerDetailedUsageRoutes(app, prisma);
  registerOldMetricsRoutes(app, prisma);
  registerSatelliteUsageRoutes(app, prisma);

  return app;
}
