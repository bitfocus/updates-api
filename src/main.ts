import { APIServer, ValidationError, z } from "@bitfocusas/api";
import { registerUpdateRoutes } from "./update.js";
import { PrismaClient } from "./prisma/client.js";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { createPool } from "mysql2/promise";

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
});

// Register routes
registerUpdateRoutes(app, prisma);

// Setup graceful shutdown
app.setupGracefulShutdown();

// Start the server
await app.start();
