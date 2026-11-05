import type {
  SatelliteUsageFeaturesType,
  SatelliteUsagePluginType,
} from "../satellite-usage.js";
import type { PrismaClient, SatelliteFeatures } from "../prisma/client.js";
import type { UpdatesBodyType } from "../update.js";
import { isUniqueConstraintError, type Complete } from "./types.js";
import { isLastSeenStale } from "./time.js";

export async function writeSatelliteFeatures(
  prisma: PrismaClient,
  machineId: string,
  app: UpdatesBodyType["app"],
  os: UpdatesBodyType["os"],
  features: SatelliteUsageFeaturesType
): Promise<boolean> {
  if (app.name !== "satellite") {
    throw new Error("Satellite feature usage can only be recorded for Satellite app");
  }

  const fullDoc: Complete<
    Omit<SatelliteFeatures, "id" | "createdAt" | "updatedAt">
  > = {
    user_id: machineId,

    // Clamp lengths to not overflow the table columns
    app_version: app.version.slice(0, 16),
    app_build: app.build.slice(0, 255),

    os_platform: os.platform.slice(0, 16),
    os_release: os.release.slice(0, 48),
    os_arch: os.arch.slice(0, 8),

    distribution: features.distribution.slice(0, 16),
    remoteProtocol: features.remoteProtocol.slice(0, 8),

    connected: features.connected,
    companionVersion: features.companionVersion?.slice(0, 64) ?? null,
    companionApiVersion: features.companionApiVersion?.slice(0, 16) ?? null,

    restEnabled: features.restEnabled,
    mdnsEnabled: features.mdnsEnabled,
  };

  const existing = await prisma.satelliteFeatures.findUnique({
    where: {
      user_id: machineId,
    },
  });

  if (!existing) {
    try {
      await prisma.satelliteFeatures.createMany({ data: fullDoc });
    } catch (e) {
      // Created concurrently by another request
      if (!isUniqueConstraintError(e)) throw e;
      await prisma.satelliteFeatures.updateMany({
        where: { user_id: machineId },
        data: fullDoc,
      });
    }
    return true;
  }

  // Reports arrive hourly and rarely change, so skip the write unless something changed or updatedAt needs refreshing
  const unchanged = (Object.keys(fullDoc) as Array<keyof typeof fullDoc>).every(
    (key) => existing[key] === fullDoc[key]
  );
  if (unchanged && !isLastSeenStale(existing.updatedAt, new Date())) {
    return true;
  }

  await prisma.satelliteFeatures.updateMany({
    where: {
      id: existing.id,
    },
    data: fullDoc,
  });

  return true;
}

/**
 * Record the state of each installed surface plugin.
 *
 * To keep database load down, the existing rows are read first and only rows which need changing are written.
 * Reports arrive hourly, and are usually identical to the previous one.
 */
export async function writeSatellitePluginsUsage(
  prisma: PrismaClient,
  machineId: string,
  plugins: SatelliteUsagePluginType[]
): Promise<boolean> {
  // It doesn't make sense to purge the last-seen data, as we do want to keep knowledge if they used it yesterday.
  if (!plugins || plugins.length === 0) return true;

  const now = new Date();

  const reported = new Map<string, PluginRow>();
  for (const plugin of plugins) {
    // Clamp lengths to not overflow the table columns
    const row: PluginRow = {
      module_name: plugin.moduleId.slice(0, 128),
      module_version: plugin.version.slice(0, 32),
      enabled: plugin.enabled,
      connected_surfaces: plugin.connectedSurfaces,
    };
    reported.set(row.module_name, row);
  }

  const existingRows = await prisma.satellitePluginUsage.findMany({
    where: { user_id: machineId },
    select: {
      id: true,
      module_name: true,
      module_version: true,
      enabled: true,
      connected_surfaces: true,
      last_seen: true,
    },
  });
  const existingByName = new Map(existingRows.map((r) => [r.module_name, r]));

  const newRows: PluginRow[] = [];
  const staleIds: number[] = [];
  for (const row of reported.values()) {
    const existing = existingByName.get(row.module_name);
    if (!existing) {
      newRows.push(row);
    } else if (
      existing.module_version !== row.module_version ||
      existing.enabled !== row.enabled ||
      existing.connected_surfaces !== row.connected_surfaces
    ) {
      await prisma.satellitePluginUsage.updateMany({
        where: { id: existing.id },
        data: { ...row, last_seen: now },
      });
    } else if (isLastSeenStale(existing.last_seen, now)) {
      staleIds.push(existing.id);
    }
  }

  if (staleIds.length > 0) {
    await prisma.satellitePluginUsage.updateMany({
      where: { id: { in: staleIds } },
      data: { last_seen: now },
    });
  }

  if (newRows.length > 0) {
    const res = await prisma.satellitePluginUsage.createMany({
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
        await prisma.satellitePluginUsage.updateMany({
          where: { user_id: machineId, module_name: row.module_name },
          data: { ...row, last_seen: now },
        });
      }
    }
  }

  return true;
}

interface PluginRow {
  module_name: string;
  module_version: string;
  enabled: boolean;
  connected_surfaces: number;
}
