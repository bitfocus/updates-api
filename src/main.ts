// Setup sentry before anything else
import "./instrument.mjs";

import { APIServer } from "@bitfocusas/api";
import { registerUpdateRoutes } from "./update.js";
import { PrismaClient } from "./prisma/client.js";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import * as Sentry from "@sentry/node";
import { registerDetailedUsageRoutes } from "./detailed-usage.js";
import { registerOldMetricsRoutes } from "./old-metrics.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

const adapter = new PrismaMariaDb(connectionString);
const prisma = new PrismaClient({
  adapter,
});

// Create API server
const app = new APIServer({
  port: 3000,
  host: "::",
  apiTitle: "Companion Update API",
  apiDescription: "Companion Update API",
  // apiTags: [{ name: "Users", description: "User management endpoints" }],
  loadEnv: false,
  metricsEnabled: true, // TODO - limit permissions of this?
  rateLimitAllow: process.env.RATE_LIMIT_ALLOW?.split(","),
  trustProxy: process.env.TRUST_PROXY,
});

// Setup Sentry error handler for Fastify
Sentry.setupFastifyErrorHandler(app.instance);

// Register routes
registerUpdateRoutes(app, prisma);
registerDetailedUsageRoutes(app, prisma);
registerOldMetricsRoutes(app, prisma);

// Setup graceful shutdown
app.setupGracefulShutdown();

// Start the server
await app.start();
