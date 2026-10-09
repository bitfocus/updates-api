import type {
  DetailedUsageConnectionType,
  DetailedUsageSurfaceModuleType,
} from "../detailed-usage.js";
import type { PrismaClient } from "../prisma/client.js";
import type { ModuleType } from "../prisma/enums.js";
import { getUtcDay, isLastSeenStale } from "./time.js";
import { isUniqueConstraintError } from "./types.js";

/**
 * Record per-version module usage counts, for both connections and surface modules (which share the same shape).
 *
 * To keep database load down, the existing rows are read first and only rows which need changing are written.
 * Reports arrive hourly, and are usually identical to the previous one.
 */
export async function writeModulesUsage(
  prisma: PrismaClient,
  machineId: string,
  connections: DetailedUsageConnectionType[],
  surfaceModules: DetailedUsageSurfaceModuleType[]
): Promise<boolean> {
  // If no modules, nothing to do.
  // It doesn't make sense to purge the last-seen data, as we do want to keep knowledge if they used it yesterday.
  // For the detailed usage, we won't decrease the max_counts either.
  const reported: Array<{
    moduleType: ModuleType;
    module: DetailedUsageConnectionType;
  }> = [
    ...(connections ?? []).map((module) => ({
      moduleType: "CONNECTION" as const,
      module,
    })),
    ...(surfaceModules ?? []).map((module) => ({
      moduleType: "SURFACE" as const,
      module,
    })),
  ];
  if (reported.length === 0) return true;

  // Clamp lengths to not overflow the table columns
  const entries = reported.map(({ moduleType, module }) => ({
    moduleType,
    moduleName: module.moduleId.slice(0, 128),
    counts: Object.entries(module.counts).map(
      ([version, count]) => [version.slice(0, 32), count] as const
    ),
  }));

  // Resolve the KnownModule row ids
  const moduleKeys: KnownModuleKey[] = [];
  for (const entry of entries) {
    // The 'sum' module has an empty version
    moduleKeys.push({ ...entry, moduleVersion: "" });
    for (const [version] of entry.counts) {
      moduleKeys.push({ ...entry, moduleVersion: version });
    }
  }
  const moduleIds = await resolveKnownModuleIds(prisma, moduleKeys);
  const getModuleId = (key: KnownModuleKey) =>
    moduleIds.get(knownModuleCacheKey(key))!;

  // Compute the instance count for each module row
  const instanceCounts = new Map<number, number>();
  const addCount = (moduleRowId: number, count: number) => {
    instanceCounts.set(
      moduleRowId,
      Math.max(instanceCounts.get(moduleRowId) ?? 0, count)
    );
  };
  for (const entry of entries) {
    let totalInstances = 0;
    for (const [version, count] of entry.counts) {
      if (count) totalInstances += count;
      addCount(getModuleId({ ...entry, moduleVersion: version }), count);
    }
    addCount(getModuleId({ ...entry, moduleVersion: "" }), totalInstances);
  }

  const now = new Date();
  await Promise.all([
    writeModuleDailyUsage(prisma, machineId, now, instanceCounts),
    writeModuleLastSeen(prisma, machineId, now, instanceCounts),
  ]);

  return true;
}

async function writeModuleDailyUsage(
  prisma: PrismaClient,
  machineId: string,
  now: Date,
  instanceCounts: ReadonlyMap<number, number>
): Promise<void> {
  const utcDay = getUtcDay(now);

  const existingRows = await prisma.moduleDailyUsage.findMany({
    where: {
      date: utcDay,
      user_id: machineId,
      module_id: { in: Array.from(instanceCounts.keys()) },
    },
    select: { id: true, module_id: true, max_count: true },
  });
  const existingById = new Map(existingRows.map((r) => [r.module_id, r]));

  const newRows: Array<{ module_id: number; max_count: number }> = [];
  for (const [moduleRowId, count] of instanceCounts) {
    const existing = existingById.get(moduleRowId);
    if (!existing) {
      newRows.push({ module_id: moduleRowId, max_count: count });
    } else if (count > existing.max_count) {
      // The guard avoids lowering a count written concurrently
      await prisma.moduleDailyUsage.updateMany({
        where: { id: existing.id, max_count: { lt: count } },
        data: { max_count: count },
      });
    }
  }

  if (newRows.length > 0) {
    const res = await prisma.moduleDailyUsage.createMany({
      data: newRows.map((r) => ({
        date: utcDay,
        user_id: machineId,
        module_id: r.module_id,
        max_count: r.max_count,
      })),
      skipDuplicates: true,
    });

    if (res.count < newRows.length) {
      // Some rows were created concurrently, ensure the counts are applied to them
      for (const row of newRows) {
        await prisma.moduleDailyUsage.updateMany({
          where: {
            date: utcDay,
            user_id: machineId,
            module_id: row.module_id,
            max_count: { lt: row.max_count },
          },
          data: { max_count: row.max_count },
        });
      }
    }
  }
}

async function writeModuleLastSeen(
  prisma: PrismaClient,
  machineId: string,
  now: Date,
  instanceCounts: ReadonlyMap<number, number>
): Promise<void> {
  const existingRows = await prisma.moduleUserLastSeen.findMany({
    where: {
      user_id: machineId,
      module_id: { in: Array.from(instanceCounts.keys()) },
    },
    select: { id: true, module_id: true, max_count: true, last_seen: true },
  });
  const existingById = new Map(existingRows.map((r) => [r.module_id, r]));

  const newRows: Array<{ module_id: number; max_count: number }> = [];
  const staleIds: number[] = [];
  for (const [moduleRowId, count] of instanceCounts) {
    const existing = existingById.get(moduleRowId);
    if (!existing) {
      newRows.push({ module_id: moduleRowId, max_count: count });
    } else if (existing.max_count !== count) {
      await prisma.moduleUserLastSeen.updateMany({
        where: { id: existing.id },
        data: { max_count: count, last_seen: now },
      });
    } else if (isLastSeenStale(existing.last_seen, now)) {
      staleIds.push(existing.id);
    }
  }

  if (staleIds.length > 0) {
    await prisma.moduleUserLastSeen.updateMany({
      where: { id: { in: staleIds } },
      data: { last_seen: now },
    });
  }

  if (newRows.length > 0) {
    const res = await prisma.moduleUserLastSeen.createMany({
      data: newRows.map((r) => ({
        user_id: machineId,
        module_id: r.module_id,
        max_count: r.max_count,
        last_seen: now,
      })),
      skipDuplicates: true,
    });

    if (res.count < newRows.length) {
      // Some rows were created concurrently, ensure they reflect this report
      for (const row of newRows) {
        await prisma.moduleUserLastSeen.updateMany({
          where: { user_id: machineId, module_id: row.module_id },
          data: { max_count: row.max_count, last_seen: now },
        });
      }
    }
  }
}

interface KnownModuleKey {
  moduleType: ModuleType;
  moduleName: string;
  moduleVersion: string; // Empty string for the 'sum' module
}

/**
 * Cache of KnownModule ids.
 * Rows in this table are never modified or deleted, so this is safe to cache indefinitely, even with multiple replicas.
 */
const knownModuleIdCache = new Map<string, number>();

function knownModuleCacheKey(key: KnownModuleKey): string {
  return JSON.stringify([key.moduleType, key.moduleName, key.moduleVersion]);
}

async function resolveKnownModuleIds(
  prisma: PrismaClient,
  keys: KnownModuleKey[]
): Promise<ReadonlyMap<string, number>> {
  const getMissing = () => {
    const missing = new Map<string, KnownModuleKey>();
    for (const key of keys) {
      const cacheKey = knownModuleCacheKey(key);
      if (!knownModuleIdCache.has(cacheKey)) missing.set(cacheKey, key);
    }
    return missing;
  };

  let missing = getMissing();
  if (missing.size === 0) return knownModuleIdCache;

  // Load all versions of the missing modules
  const missingNames = new Map<ModuleType, Set<string>>();
  for (const key of missing.values()) {
    let names = missingNames.get(key.moduleType);
    if (!names) missingNames.set(key.moduleType, (names = new Set()));
    names.add(key.moduleName);
  }
  const rows = await prisma.knownModule.findMany({
    where: {
      OR: Array.from(missingNames, ([moduleType, names]) => ({
        module_type: moduleType,
        module_name: { in: Array.from(names) },
      })),
    },
    select: {
      id: true,
      module_type: true,
      module_name: true,
      module_version: true,
    },
  });
  for (const row of rows) {
    knownModuleIdCache.set(
      knownModuleCacheKey({
        moduleType: row.module_type,
        moduleName: row.module_name,
        moduleVersion: row.module_version,
      }),
      row.id
    );
  }

  // Create any which don't exist yet. This is rare, so do them individually.
  // This also finds names which only differ by the database collation (eg casing), as the unique lookup will match the existing row
  missing = getMissing();
  for (const [cacheKey, key] of missing) {
    const data = {
      module_type: key.moduleType,
      module_name: key.moduleName,
      module_version: key.moduleVersion,
    };
    const where = { module_type_module_name_module_version: data };

    let row = await prisma.knownModule.findUnique({
      where,
      select: { id: true },
    });
    if (!row) {
      try {
        row = await prisma.knownModule.create({ data, select: { id: true } });
        console.log("created module", key.moduleName, key.moduleVersion, row.id);
      } catch (e) {
        // Created concurrently by another request
        if (!isUniqueConstraintError(e)) throw e;
        row = await prisma.knownModule.findUniqueOrThrow({
          where,
          select: { id: true },
        });
      }
    }
    knownModuleIdCache.set(cacheKey, row.id);
  }

  return knownModuleIdCache;
}
