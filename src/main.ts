// Setup sentry before anything else
import "./instrument.mjs";

import { APIServer } from "@bitfocusas/api";
import { registerUpdateRoutes } from "./update.js";
import { PrismaClient } from "./prisma/client.js";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import * as Sentry from "@sentry/node";
import { registerDetailedUsageRoutes } from "./detailed-usage.js";
import { registerOldMetricsRoutes } from "./old-metrics.js";

const adapter = new PrismaMariaDb({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "") || 3306,
  database: process.env.DB_NAME || "updates_api",
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || "") || 20,
});
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
