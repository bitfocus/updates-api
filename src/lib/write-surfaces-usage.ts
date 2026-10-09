import type { DetailedUsageSurfaceType } from "../detailed-usage.js";
import type { PrismaClient } from "../prisma/client.js";
import * as Sentry from "@sentry/node";
import crypto from "crypto";
import { getUtcDay, isLastSeenStale } from "./time.js";

/**
 * Record surface usage.
 *
 * To keep database load down, the existing rows are read first and only rows which need changing are written.
 * Reports arrive hourly, and are usually identical to the previous one.
 */
export async function writeSurfacesUsage(
  prisma: PrismaClient,
  machineId: string,
  surfaces: DetailedUsageSurfaceType[]
): Promise<boolean> {
  // If no surfaces, nothing to do.
  // It doesn't make sense to purge the last-seen data, as we do want to keep knowledge if they used it yesterday.
  // For the detailed usage, we won't decrease the max_counts either.
  if (!surfaces || surfaces.length === 0) return true;

  const now = new Date();

  const [usageOk, lastSeenOk] = await Promise.all([
    writeSurfacesDailyUsage(prisma, machineId, now, surfaces),
    writeSurfacesLastSeen(prisma, machineId, now, surfaces),
  ]);

  return usageOk && lastSeenOk;
}

async function writeSurfacesDailyUsage(
  prisma: PrismaClient,
  machineId: string,
  now: Date,
  surfaces: DetailedUsageSurfaceType[]
) {
  try {
    const utcDay = getUtcDay(now);

    // Build a map of counts per module
    const moduleCounts = new Map<string, number>();
    for (const surface of surfaces) {
      const safeModuleName = surface.moduleId.slice(0, 128); // Trim to fit DB
      moduleCounts.set(safeModuleName, (moduleCounts.get(safeModuleName) ?? 0) + 1);
    }

    const existingRows = await prisma.surfaceDailyUsage.findMany({
      where: {
        date: utcDay,
        user_id: machineId,
      },
      select: {
        id: true,
        module_name: true,
        max_count: true,
      },
    });
    const existingByName = new Map(existingRows.map((r) => [r.module_name, r]));

    const newRows: Array<{ module_name: string; max_count: number }> = [];
    for (const [moduleName, count] of moduleCounts) {
      const existing = existingByName.get(moduleName);
      if (!existing) {
        newRows.push({ module_name: moduleName, max_count: count });
      } else if (count > existing.max_count) {
        // The guard avoids lowering a count written concurrently
        await prisma.surfaceDailyUsage.updateMany({
          where: { id: existing.id, max_count: { lt: count } },
          data: { max_count: count },
        });
      }
    }

    if (newRows.length > 0) {
      const res = await prisma.surfaceDailyUsage.createMany({
        data: newRows.map((r) => ({
          date: utcDay,
          user_id: machineId,
          module_name: r.module_name,
          max_count: r.max_count,
        })),
        skipDuplicates: true,
      });

      if (res.count < newRows.length) {
        // Some rows already existed (created concurrently, or differing only by collation), ensure the counts are applied to them
        for (const row of newRows) {
          await prisma.surfaceDailyUsage.updateMany({
            where: {
              date: utcDay,
              user_id: machineId,
              module_name: row.module_name,
              max_count: { lt: row.max_count },
            },
            data: { max_count: row.max_count },
          });
        }
      }
    }

    return true;
  } catch (e) {
    Sentry.captureException(e, { extra: { surfaces } });
    return false;
  }
}

async function writeSurfacesLastSeen(
  prisma: PrismaClient,
  machineId: string,
  now: Date,
  surfaces: DetailedUsageSurfaceType[]
) {
  try {
    const reported = new Map<string, SurfaceRow>();
    const oldSerialsToPrune = new Set<string>();

    for (const surface of surfaces) {
      const row = {
        module_name: surface.moduleId.slice(0, 128), // Trim to fit DB
        surface_serial: surface.id.slice(0, 64), // Trim to fit DB
        surface_description: translateDescription(surface.description).slice(
          0,
          128
        ), // Trim to fit DB
      };
      reported.set(surfaceKey(row), row);

      try {
        // Hash the raw serial
        oldSerialsToPrune.add(
          crypto.createHash("md5").update(surface.id).digest("hex")
        );

        // The hashed version could be from before we added the prefix scheme
        const colonIndex = surface.id.indexOf(":");
        if (colonIndex !== -1) {
          const suffix = surface.id.slice(colonIndex + 1);
          oldSerialsToPrune.add(
            crypto.createHash("md5").update(suffix).digest("hex")
          );

          // Just in case, maybe it was hashed with a satellite- prefix
          oldSerialsToPrune.add(
            crypto
              .createHash("md5")
              .update(`satellite-${suffix}`)
              .digest("hex")
          );
        }
      } catch (e) {
        Sentry.captureException(e, { extra: { surface } });
      }
    }

    const existingRows = await prisma.surfaceUserLastSeen.findMany({
      where: { user_id: machineId },
      select: {
        id: true,
        module_name: true,
        surface_serial: true,
        surface_description: true,
        last_seen: true,
      },
    });
    const existingByKey = new Map(existingRows.map((r) => [surfaceKey(r), r]));

    // Prune any old serials that were stored with legacy hashing
    // Future: This could maybe be more intelligent, by fixing up existing rows (from all users) instead of deleting for the current user.
    // But that will involve a bunch more queries and complexity, so for now just delete.
    const pruneIds = existingRows
      .filter(
        (r) =>
          oldSerialsToPrune.has(r.surface_serial) &&
          !reported.has(surfaceKey(r))
      )
      .map((r) => r.id);
    if (pruneIds.length > 0) {
      try {
        await prisma.surfaceUserLastSeen.deleteMany({
          where: { id: { in: pruneIds } },
        });
      } catch (e) {
        // If pruning fails for any reason, capture and continue to
        // ensure we still write the updates below.
        Sentry.captureException(e, { extra: { surfaces, pruneIds } });
      }
    }

    const newRows: SurfaceRow[] = [];
    const staleIds: number[] = [];
    for (const [key, row] of reported) {
      const existing = existingByKey.get(key);
      if (!existing) {
        newRows.push(row);
      } else if (existing.surface_description !== row.surface_description) {
        await prisma.surfaceUserLastSeen.updateMany({
          where: { id: existing.id },
          data: { surface_description: row.surface_description, last_seen: now },
        });
      } else if (isLastSeenStale(existing.last_seen, now)) {
        staleIds.push(existing.id);
      }
    }

    if (staleIds.length > 0) {
      await prisma.surfaceUserLastSeen.updateMany({
        where: { id: { in: staleIds } },
        data: { last_seen: now },
      });
    }

    if (newRows.length > 0) {
      const res = await prisma.surfaceUserLastSeen.createMany({
        data: newRows.map((r) => ({
          user_id: machineId,
          ...r,
          last_seen: now,
        })),
        skipDuplicates: true,
      });

      if (res.count < newRows.length) {
        // Some rows already existed (created concurrently, or differing only by collation), ensure they reflect this report
        for (const row of newRows) {
          await prisma.surfaceUserLastSeen.updateMany({
            where: {
              user_id: machineId,
              module_name: row.module_name,
              surface_serial: row.surface_serial,
            },
            data: { surface_description: row.surface_description, last_seen: now },
          });
        }
      }
    }

    return true;
  } catch (e) {
    Sentry.captureException(e, { extra: { surfaces } });
    return false;
  }
}

interface SurfaceRow {
  module_name: string;
  surface_serial: string;
  surface_description: string;
}

function surfaceKey(row: { module_name: string; surface_serial: string }) {
  return JSON.stringify([row.module_name, row.surface_serial]);
}

function translateDescription(description: string): string {
  // Fixup some bad naming from some old surface module implementation
  if (description.startsWith("Elgato ")) {
    description = description.replace(/\s+\([A-Z0-9]{10,}\)$/, "");
  }

  switch (description) {
    case "Stream Deck":
    case "Satellite StreamDeck: original":
    case "Satellite StreamDeck: originalv2":
      return "Elgato Stream Deck";
    case "Stream Deck XL":
    case "Satellite StreamDeck: xl":
    case "Satellite StreamDeck: xlv2":
      return "Elgato Stream Deck XL";
    case "Stream Deck Mini":
    case "Satellite StreamDeck: mini":
    case "Satellite StreamDeck: miniv2":
      return "Elgato Stream Deck Mini";
    case "Stream Deck MK.2":
    case "Satellite StreamDeck: original-mk2":
      return "Elgato Stream Deck MK.2";
    case "Stream Deck +":
    case "Satellite StreamDeck: plus":
    case "Elgato Stream Deck Plus":
      return "Elgato Stream Deck +";
    case "Stream Deck Pedal":
    case "Satellite StreamDeck: pedal":
      return "Elgato Stream Deck Pedal";
    case "Stream Deck Neo":
    case "Satellite StreamDeck: neo":
      return "Elgato Stream Deck Neo";
    case "Stream Deck 15 Module":
      return "Elgato Stream Deck 15 Module";
    case "Stream Deck 32 Module":
      return "Elgato Stream Deck 32 Module";
    case "Stream Deck 6 Module":
      return "Elgato Stream Deck 6 Module";
    case "Stream Deck MK.2 (Scissor)":
      return "Elgato Stream Deck MK.2 (Scissor)";
    case "Stream Deck Studio":
      return "Elgato Stream Deck Studio";
  }

  if (description.includes("MakePro X Glue")) {
    return "MakePro X Glue";
  }

  // Assume it is already good
  return description;
}
