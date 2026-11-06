// Setup sentry before anything else
import "./instrument.mjs";

import { PrismaClient } from "./prisma/client.js";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { createApp } from "./app.js";

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
const app = createApp(prisma, {
  port: 3000,
  host: "::",
  metricsEnabled: true, // TODO - limit permissions of this?
  rateLimitAllow: process.env.RATE_LIMIT_ALLOW?.split(","),
  trustProxy: process.env.TRUST_PROXY,
});

// Setup graceful shutdown
app.setupGracefulShutdown();

// Start the server
await app.start();
