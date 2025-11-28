#!/usr/bin/env node

/**
 * Migration script to import data from old MariaDB database to new Prisma-managed database
 *
 * This script:
 * - Streams rows from the old database to handle hundreds of thousands of records
 * - Maps old `id` field to new `user_id` field
 * - Skips rows that already exist in the new database (based on user_id + app_name)
 * - Sets createdAt and updatedAt to the old row's last_seen timestamp
 *
 * Usage:
 *   OLD_DB_HOST=localhost OLD_DB_PORT=3306 OLD_DB_USER=root OLD_DB_PASSWORD=password OLD_DB_NAME=old_db node import.mjs
 */

import mariadb from "mariadb";
import { PrismaClient } from "./prisma/client.js";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

// Configuration from environment variables
const OLD_DB_CONFIG = {
  host: process.env.OLD_DB_HOST || "localhost",
  port: parseInt(process.env.OLD_DB_PORT || "3306"),
  user: process.env.OLD_DB_USER || "root",
  password: process.env.OLD_DB_PASSWORD || "",
  database: process.env.OLD_DB_NAME || "companion_stats",
  connectionLimit: 5,
};

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "100");
const DRY_RUN = process.env.DRY_RUN === "true";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

const adapter = new PrismaMariaDb(connectionString);
const prisma = new PrismaClient({
  adapter,
});

let stats = {
  total: 0,
  skipped: 0,
  imported: 0,
  updated: 0,
  errors: 0,
};

async function main() {
  console.log("Starting migration...");
  console.log(
    `Old DB: ${OLD_DB_CONFIG.host}:${OLD_DB_CONFIG.port}/${OLD_DB_CONFIG.database}`
  );
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log("");

  let pool;
  let conn;

  try {
    // Connect to old database
    pool = mariadb.createPool(OLD_DB_CONFIG);
    conn = await pool.getConnection();
    console.log("✓ Connected to old database");

    // Test new database connection
    await prisma.$connect();
    console.log("✓ Connected to new database");
    console.log("");

    // Get total count
    // const countResult = await conn.query("SELECT COUNT(*) as count FROM user");
    // const totalRows = countResult[0].count;
    // console.log(`Total rows in old database: ${totalRows.toLocaleString()}`);
    // console.log("");
    const totalRows = 697133;

    // Stream rows from old database
    const queryStream = conn.queryStream("SELECT * FROM user ORDER BY id");

    let batch = [];
    let processedCount = 0;

    for await (const row of queryStream) {
      stats.total++;
      batch.push(row);

      if (batch.length >= BATCH_SIZE) {
        await processBatch(batch);
        processedCount += batch.length;
        batch = [];

        // Progress update
        const progress = ((processedCount / totalRows) * 100).toFixed(2);
        console.log(
          `Progress: ${processedCount.toLocaleString()}/${totalRows.toLocaleString()} (${progress}%) - Imported: ${
            stats.imported
          }, Updated: ${stats.updated}, Skipped: ${stats.skipped}, Errors: ${
            stats.errors
          }`
        );
      }
    }

    // Process remaining rows
    if (batch.length > 0) {
      await processBatch(batch);
      processedCount += batch.length;
    }

    console.log("");
    console.log("Migration completed!");
    console.log("===================");
    console.log(`Total rows processed: ${stats.total.toLocaleString()}`);
    console.log(`Imported: ${stats.imported.toLocaleString()}`);
    console.log(`Updated: ${stats.updated.toLocaleString()}`);
    console.log(`Skipped (already exists): ${stats.skipped.toLocaleString()}`);
    console.log(`Errors: ${stats.errors.toLocaleString()}`);
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
    if (pool) await pool.end();
    await prisma.$disconnect();
  }
}

async function processBatch(rows: any[]) {
  // First, check which rows already exist in the new database
  const userIdAppNamePairs = rows.map((row) => ({
    user_id: row.id,
    app_name: row.app_name,
  }));

  // Query existing records with their updatedAt timestamps
  const existing = await prisma.user.findMany({
    where: {
      OR: userIdAppNamePairs,
    },
    select: {
      user_id: true,
      app_name: true,
      updatedAt: true,
    },
  });

  // Create a map of existing records for fast lookup
  const existingMap = new Map(
    existing.map((e) => [`${e.user_id}:${e.app_name}`, e])
  );

  // Separate rows into new inserts and updates
  const rowsToImport: any[] = [];
  const rowsToUpdate: any[] = [];
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

  for (const row of rows) {
    const key = `${row.id}:${row.app_name}`;
    const existingRecord = existingMap.get(key);

    if (!existingRecord) {
      // New record, needs to be inserted
      rowsToImport.push(row);
    } else {
      const timeDiff =
        new Date(row.last_seen).getTime() -
        new Date(existingRecord.updatedAt).getTime();
      if (timeDiff > TWO_HOURS_MS) {
        // Existing record with older timestamp (more than 10 minutes difference), needs to be updated
        rowsToUpdate.push(row);
      } else {
        // Existing record is up-to-date (within 10 minute tolerance), skip
        stats.skipped++;
      }
    }
  }

  if (rowsToImport.length === 0 && rowsToUpdate.length === 0) {
    return; // Nothing to import or update
  }

  if (DRY_RUN) {
    console.log(
      `[DRY RUN] Would import ${rowsToImport.length} rows and update ${rowsToUpdate.length} rows`
    );
    stats.imported += rowsToImport.length;
    stats.updated += rowsToUpdate.length;
    return;
  }

  // Handle new records
  if (rowsToImport.length > 0) {
    const dataToInsert = rowsToImport.map((row) => ({
      user_id: row.id,
      app_name: row.app_name,
      app_version: row.app_version,
      app_build: row.app_build,
      os_platform: row.os_platform,
      os_release: row.os_release,
      os_arch: row.os_arch,
      createdAt: row.last_seen,
      updatedAt: row.last_seen,
    }));

    try {
      // Use createMany for efficient bulk insert
      const result = await prisma.user.createMany({
        data: dataToInsert,
        skipDuplicates: true, // Extra safety in case of race conditions
      });

      stats.imported += result.count;
    } catch (error) {
      console.error(
        `Error importing batch: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      // Fallback: try inserting one by one in parallel
      const insertPromises = dataToInsert.map(async (data) => {
        try {
          await prisma.user.create({ data });
          return { success: true };
        } catch (err) {
          console.error(
            `Error importing row (user_id: ${data.user_id}, app_name: ${
              data.app_name
            }): ${err instanceof Error ? err.message : String(err)}`
          );
          return { success: false };
        }
      });

      const results = await Promise.all(insertPromises);
      stats.imported += results.filter((r) => r.success).length;
      stats.errors += results.filter((r) => !r.success).length;
    }
  }

  // Handle updates for existing records with newer timestamps
  if (rowsToUpdate.length > 0) {
    const updatePromises = rowsToUpdate.map(async (row) => {
      try {
        await prisma.user.update({
          where: {
            user_id_app_name: {
              user_id: row.id,
              app_name: row.app_name,
            },
          },
          data: {
            app_version: row.app_version,
            app_build: row.app_build,
            os_platform: row.os_platform,
            os_release: row.os_release,
            os_arch: row.os_arch,
            updatedAt: row.last_seen,
          },
        });
        return { success: true };
      } catch (err) {
        console.error(
          `Error updating row (user_id: ${row.id}, app_name: ${
            row.app_name
          }): ${err instanceof Error ? err.message : String(err)}`
        );
        return { success: false };
      }
    });

    const results = await Promise.all(updatePromises);
    stats.updated += results.filter((r) => r.success).length;
    stats.errors += results.filter((r) => !r.success).length;
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
