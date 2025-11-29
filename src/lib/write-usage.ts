import type {
  DetailedUsageBodyType,
  DetailedUsageSurfaceType,
} from "../detailed-usage.js";
import type { PrismaClient } from "../prisma/client.js";
import { writeConnectionsUsage } from "./write-connections-usage.js";
import { writeSurfacesUsage } from "./write-surfaces-usage.js";

export async function writeUsageData(
  prisma: PrismaClient,
  data: DetailedUsageBodyType
): Promise<void> {
  // Implement the logic to write usage data to your desired location

  // TODO basic info
  // TODO features

  // TODO - ok/error handling
  await Promise.all([
    writeSurfacesUsage(prisma, data.id, data.surfaces),
    writeConnectionsUsage(prisma, data.id, data.connections),
  ]);
}

/*
export async function clearOtherUsageData(
  prisma: PrismaClient,
  machineId: string
): Promise<void> {
  // This should clear any usage data which is not surfaces or connections
  // TODO basic info?
  // TODO features
}
*/
