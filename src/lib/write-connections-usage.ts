import type { DetailedUsageConnectionType } from "../detailed-usage.js";
import type { PrismaClient } from "../prisma/client.js";
import type { PrismaTransaction } from "./types.js";
import * as Sentry from "@sentry/node";

export async function writeConnectionsUsage(
  prisma: PrismaClient,
  machineId: string,
  connections: DetailedUsageConnectionType[]
): Promise<boolean> {
  // If no connections, nothing to do.
  // It doesn't make sense to purge the last-seen data, as we do want to keep knowledge if they used it yesterday.
  // For the detailed usage, we won't decrease the max_counts either.
  if (!connections || connections.length === 0) return true;

  let ok = true;

  const now = new Date();
  const utcDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ); // midnight UTC

  // Fetch existing rows, to allow for updating in place
  const [existingDailyRowsRaw, existingLastSeenRowsRaw] = await Promise.all([
    prisma.moduleDailyUsage.findMany({
      where: {
        date: utcDay,
        user_id: machineId,
      },
      select: {
        id: true,
        module_id: true,
        max_count: true,
      },
    }),
    prisma.moduleUserLastSeen.findMany({
      where: {
        user_id: machineId,
      },
      select: {
        id: true,
        module_id: true,
        max_count: true,
      },
    }),
  ]);

  const common: CommonData = {
    machineId,
    now,
    utcDay,

    existingDailyRowCounts: new Map(
      existingDailyRowsRaw.map((r) => [
        r.module_id,
        { id: r.id, count: r.max_count },
      ])
    ),
    existingLastSeenRowCounts: new Map(
      existingLastSeenRowsRaw.map((r) => [
        r.module_id,
        { id: r.id, count: r.max_count },
      ])
    ),
  };

  // Note: do these sequentially, to avoid spawning too many concurrent operations
  for (const conn of connections) {
    try {
      const moduleName = conn.moduleId.slice(0, 128); // Clamp length to not overflow the table column

      // Fetch all the possible versions
      const moduleRowIds = await findModuleRowIds(prisma, moduleName);
      // Helper to get from the cached, or to upsert a new row
      const getOrCreateModuleRowId = async (
        version0: string | null
      ): Promise<number> => {
        const version = version0 ? version0.slice(0, 32) : null; // Clamp length to not overflow the table column

        let rowId = moduleRowIds.get(version);
        if (rowId === undefined) {
          // No need to worry about race conditions as this performs an upsert
          // This intentionally does not use the transaction, to avoid contention across multiple users
          rowId = await createConnectionModule(prisma, moduleName, version);
          moduleRowIds.set(version, rowId);
        }
        return rowId;
      };

      // Ensure the 'sum' module exists
      const sumModuleRowId = await getOrCreateModuleRowId(null);

      // normalize counts and compute total instances
      let totalInstances = 0;
      for (const cnt of Object.values(conn.counts)) {
        if (cnt) totalInstances += cnt;
      }

      // Run the updates in a transaction
      await prisma.$transaction(
        async (tx) => {
          try {
            await updateConnectionModuleCounts(
              tx,
              common,
              sumModuleRowId,
              totalInstances
            );
          } catch (e) {
            ok = false;

            Sentry.captureException(e, {
              extra: { connection: conn },
            });
          }

          // Do in series to minimise connection usage
          for (const [ver, cnt] of Object.entries(conn.counts)) {
            try {
              const moduleRowId = await getOrCreateModuleRowId(ver);
              await updateConnectionModuleCounts(tx, common, moduleRowId, cnt);
            } catch (e) {
              ok = false;

              Sentry.captureException(e, {
                extra: {
                  connectionVersion: ver,
                  count: cnt,
                  connection: conn,
                },
              });
            }
          }
        },
        {
          timeout: 20000, // High timeout, due to number of operations
        }
      );
    } catch (e) {
      ok = false;

      Sentry.captureException(e, { extra: { connection: conn } });
    }
  }

  return ok;
}

async function findModuleRowIds(prisma: PrismaClient, moduleName: string) {
  const rows = await prisma.knownModule.findMany({
    where: {
      module_type: "CONNECTION",
      module_name: moduleName,
    },
    select: {
      id: true,
      module_version: true,
    },
  });
  return new Map<string | null, number>(
    rows.map((r) => [r.module_version || null, r.id])
  );
}

async function createConnectionModule(
  prisma: PrismaTransaction,
  moduleName: string,
  moduleVersion: string | null
) {
  const row = await prisma.knownModule.upsert({
    where: {
      module_type_module_name_module_version: {
        module_type: "CONNECTION",
        module_name: moduleName,
        module_version: moduleVersion || "",
      },
    },
    create: {
      module_type: "CONNECTION",
      module_name: moduleName,
      module_version: moduleVersion || "",
    },
    update: {},
    select: {
      id: true,
    },
  });
  console.log("created module", moduleName, moduleVersion, row.id);
  return row.id;
}
interface CommonData {
  machineId: string;
  now: Date;
  utcDay: Date;

  existingDailyRowCounts: ReadonlyMap<number, { id: number; count: number }>;
  existingLastSeenRowCounts: ReadonlyMap<number, { id: number; count: number }>;
}

async function updateConnectionModuleCounts(
  prisma: PrismaTransaction,
  common: CommonData,
  moduleRowId: number,
  instanceCount: number
) {
  const existingDaily = common.existingDailyRowCounts.get(moduleRowId);
  const existingLastSeen = common.existingLastSeenRowCounts.get(moduleRowId);

  const newDailyMax = Math.max(existingDaily?.count ?? 0, instanceCount);
  const newLastSeenMax = Math.max(existingLastSeen?.count ?? 0, instanceCount);

  await Promise.all([
    prisma.moduleDailyUsage.upsert({
      where: {
        date_user_module: {
          date: common.utcDay,
          user_id: common.machineId,
          module_id: moduleRowId,
        },
      },
      update: {
        max_count: newDailyMax,
      },
      create: {
        date: common.utcDay,
        user_id: common.machineId,
        module_id: moduleRowId,
        max_count: newDailyMax,
      },
      select: { id: true },
    }),
    prisma.moduleUserLastSeen.upsert({
      where: {
        user_id_module_id: {
          user_id: common.machineId,
          module_id: moduleRowId,
        },
      },
      update: {
        last_seen: common.now,
        max_count: newLastSeenMax,
      },
      create: {
        user_id: common.machineId,
        module_id: moduleRowId,
        last_seen: common.now,
        max_count: newLastSeenMax,
      },
      select: { id: true },
    }),
  ]);
}
