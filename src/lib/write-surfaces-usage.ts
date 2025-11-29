import type { DetailedUsageSurfaceType } from "../detailed-usage.js";
import type { PrismaClient } from "../prisma/client.js";
import * as Sentry from "@sentry/node";

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
        for (const surface of surfaces) {
          try {
            const safeModuleName = surface.moduleId.slice(0, 128); // Trim to fit DB
            const safeSerial = surface.id.slice(0, 64); // Trim to fit DB
            const safeDescription = surface.description.slice(0, 128); // Trim to fit DB

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
