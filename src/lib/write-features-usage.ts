import type { DetailedUsageFeaturesType } from "../detailed-usage.js";
import type { PrismaClient } from "../prisma/client.js";

export async function writeFeatureUsageData(
  prisma: PrismaClient,
  machineId: string,
  features: DetailedUsageFeaturesType
): Promise<boolean> {
  // Implement the logic to write usage data to your desired location
  // TODO basic info
  // TODO features
  // // TODO - ok/error handling
  // await Promise.all([
  //   writeSurfacesUsage(prisma, data.id, data.surfaces),
  //   writeConnectionsUsage(prisma, data.id, data.connections),
  // ]);

  return true;
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
