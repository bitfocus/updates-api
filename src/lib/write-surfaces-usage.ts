import type { DetailedUsageSurfaceType } from "../detailed-usage.js";
import type { PrismaClient } from "../prisma/client.js";
import * as Sentry from "@sentry/node";
import crypto from "crypto";

export async function writeSurfacesUsage(
  prisma: PrismaClient,
  machineId: string,
  surfaces: DetailedUsageSurfaceType[]
): Promise<boolean> {
  // If no surfaces, nothing to do.
  // It doesn't make sense to purge the last-seen data, as we do want to keep knowledge if they used it yesterday.
  // For the detailed usage, we won't decrease the max_counts either.
  if (!surfaces || surfaces.length === 0) return true;

  const [usageOk, lastSeenOk] = await Promise.all([
    writeSurfacesDailyUsage(prisma, machineId, surfaces),
    writeSurfacesLastSeen(prisma, machineId, surfaces),
  ]);

  return usageOk && lastSeenOk;
}

async function writeSurfacesDailyUsage(
  prisma: PrismaClient,
  machineId: string,
  surfaces: DetailedUsageSurfaceType[]
) {
  try {
    const now = new Date();
    const utcDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    ); // midnight UTC

    let ok = true;

    // Fetch existing rows, to allow for updating in place
    const existingCountsRaw = await prisma.surfaceDailyUsage.findMany({
      where: {
        date: utcDay,
        user_id: machineId,
      },
      select: {
        module_name: true,
        max_count: true,
      },
    });
    const existingCounts = new Map(
      existingCountsRaw.map((r) => [r.module_name, r.max_count])
    );

    // Build a map of counts per module
    const moduleCounts = new Map<string, number>();
    for (const surface of surfaces) {
      moduleCounts.set(
        surface.moduleId,
        (moduleCounts.get(surface.moduleId) ?? 0) + 1
      );
    }

    // Write the counts in a transaction
    await prisma.$transaction(
      async (tx) => {
        // Do in series to minimise connection usage
        for (const [moduleName, count] of moduleCounts) {
          try {
            const existingCount = existingCounts.get(moduleName) ?? 0;
            const newMax = Math.max(existingCount, count);

            const safeModuleName = moduleName.slice(0, 128); // Trim to fit DB

            await tx.surfaceDailyUsage.upsert({
              where: {
                date_user_module: {
                  date: utcDay,
                  user_id: machineId,
                  module_name: safeModuleName,
                },
              },
              update: {
                max_count: newMax,
              },
              create: {
                date: utcDay,
                user_id: machineId,
                module_name: safeModuleName,
                max_count: newMax,
              },
              select: { id: true },
            });
          } catch (e) {
            ok = false;

            Sentry.captureException(e, {
              extra: { surfaceModule: moduleName, count },
            });
          }
        }
      },
      {
        timeout: 10000, // High timeout, due to number of operations
      }
    );

    return ok;
  } catch (e) {
    Sentry.captureException(e, { extra: { surfaces } });
    return false;
  }
}

async function writeSurfacesLastSeen(
  prisma: PrismaClient,
  machineId: string,
  surfaces: DetailedUsageSurfaceType[]
) {
  const now = new Date();

  let ok = true;

  // Write the last seen updates in a transaction
  await prisma
    .$transaction(
      async (tx) => {
        const oldSerialsToPrune = new Set<string>();

        for (const surface of surfaces) {
          try {
            const safeModuleName = surface.moduleId.slice(0, 128); // Trim to fit DB
            const safeSerial = surface.id.slice(0, 64); // Trim to fit DB
            const safeDescription = translateDescription(
              surface.description
            ).slice(0, 128); // Trim to fit DB

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

            await tx.surfaceUserLastSeen.upsert({
              where: {
                user_id_module_name_surface_serial: {
                  user_id: machineId,
                  module_name: safeModuleName,
                  surface_serial: safeSerial,
                },
              },
              update: {
                surface_description: safeDescription,
                last_seen: now,
              },
              create: {
                user_id: machineId,
                module_name: safeModuleName,
                surface_serial: safeSerial,
                surface_description: safeDescription,
                last_seen: now,
              },
              select: { id: true },
            });
          } catch (e) {
            ok = false;

            Sentry.captureException(e, {
              extra: {
                surface,
              },
            });
          }
        }

        // Prune any old serials that were stored with legacy hashing
        if (oldSerialsToPrune.size > 0) {
          // Future: This could maybe be more intelligent, by fixing up existing rows (from all users) instead of deleting for the current user.
          // But that will involve a bunch more queries and complexity, so for now just delete.

          const serialsArr = Array.from(oldSerialsToPrune);
          try {
            await tx.surfaceUserLastSeen.deleteMany({
              where: {
                user_id: machineId,
                surface_serial: { in: serialsArr },
              },
            });
          } catch (e) {
            // If pruning fails for any reason, capture and continue to
            // ensure we still write the upsert below.
            Sentry.captureException(e, { extra: { surfaces, serialsArr } });
          }
        }
      },
      {
        timeout: 10000, // High timeout, due to number of operations
      }
    )
    .catch((e) => {
      ok = false;

      Sentry.captureException(e, {
        extra: {
          surfaces,
        },
      });
    });

  return ok;
}

function translateDescription(description: string): string {
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
    case "Elgato Stream Deck Plus";
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
