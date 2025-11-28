import type {
  DetailedUsageBodyType,
  DetailedUsageConnectionType,
  DetailedUsageSurfaceType,
} from "../detailed-usage.js";
import type { PrismaClient } from "../prisma/client.js";

export async function writeUsageData(
  prisma: PrismaClient,
  data: DetailedUsageBodyType
): Promise<void> {
  // Implement the logic to write usage data to your desired location

  // TODO basic info
  // TODO features

  await Promise.all([
    writeSurfacesUsage(prisma, data.id, data.surfaces),
    writeConnectionsUsage(prisma, data.id, data.connections),
  ]);
}

export async function clearOtherUsageData(
  prisma: PrismaClient,
  machineId: string
): Promise<void> {
  // This should clear any usage data which is not surfaces or connections
  // TODO basic info?
  // TODO features
}

export async function writeSurfacesUsage(
  prisma: PrismaClient,
  machineId: string,
  surfaces: DetailedUsageSurfaceType[]
): Promise<void> {
  // TODO
}
export async function writeConnectionsUsage(
  prisma: PrismaClient,
  machineId: string,
  connections: DetailedUsageConnectionType[]
): Promise<void> {
  // TODO
}
