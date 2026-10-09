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

const dbUrl = new URL(connectionString);
const adapter = new PrismaMariaDb({
  host: dbUrl.hostname,
  port: parseInt(dbUrl.port) || 3306,
  database: dbUrl.pathname.slice(1), // Remove leading slash
  user: dbUrl.username || undefined,
  password: dbUrl.password || undefined,
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
Sentry.setupFastifyErrorHandler(app.instance, {
  shouldHandleError(error, _request, reply) {
    // Client disconnected mid-request, nothing we can do about it
    if ((error as NodeJS.ErrnoException).code === "ECONNRESET") return false;

    // Errors thrown from hooks (eg rate-limit) carry their status on the error, not yet on the reply
    const statusCode =
      (error as { statusCode?: number }).statusCode ?? reply.statusCode;
    return statusCode >= 500 || statusCode <= 299;
  },
});

// Redirect the root path to the Companion website
app.instance.get("/", (_request, reply) => {
  reply.redirect("https://companion.free");
});

// Register routes
registerUpdateRoutes(app, prisma);
registerDetailedUsageRoutes(app, prisma);
registerOldMetricsRoutes(app, prisma);

// Setup graceful shutdown
app.setupGracefulShutdown();

// Start the server
await app.start();
