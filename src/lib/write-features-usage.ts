import type { DetailedUsageFeaturesType } from "../detailed-usage.js";
import type { CompanionFeatures, PrismaClient } from "../prisma/client.js";
import type { UpdatesBodyType } from "../update.js";
import type { Complete } from "./types.js";

export async function writeFeatureUsageData(
  prisma: PrismaClient,
  machineId: string,
  app: UpdatesBodyType["app"],
  os: UpdatesBodyType["os"],
  features: DetailedUsageFeaturesType
): Promise<boolean> {
  // Implement the logic to write usage data to your desired location

  if (app.name !== "companion") {
    throw new Error("Feature usage can only be recorded for Companion app");
  }

  const fullDoc: Complete<
    Omit<CompanionFeatures, "id" | "createdAt" | "updatedAt">
  > = {
    user_id: machineId,

    app_version: app.version,
    app_build: app.build,

    os_platform: os.platform,
    os_release: os.release,
    os_arch: os.arch,

    // General feature flags
    isBoundToLoopback: features.isBoundToLoopback,
    hasAdminPassword: features.hasAdminPassword,
    hasPincodeLockout: features.hasPincodeLockout,
    cloudEnabled: features.cloudEnabled,
    httpsEnabled: features.httpsEnabled,

    // Protocol usage
    tcpEnabled: features.tcpEnabled,
    tcpDeprecatedEnabled: features.tcpDeprecatedEnabled,
    udpEnabled: features.udpEnabled,
    udpDeprecatedEnabled: features.udpDeprecatedEnabled,
    oscEnabled: features.oscEnabled,
    oscDeprecatedEnabled: features.oscDeprecatedEnabled,
    rossTalkEnabled: features.rossTalkEnabled,
    emberPlusEnabled: features.emberPlusEnabled,
    artnetEnabled: features.artnetEnabled,

    // Usage counts
    connectionCount: features.connectionCount,
    pageCount: features.pageCount,
    buttonCount: features.buttonCount,
    triggerCount: features.triggerCount,
    surfaceGroupCount: features.surfaceGroupCount,
    customVariableCount: features.customVariableCount,
    expressionVariableCount: features.expressionVariableCount,

    gridMinCol: features.gridSize.minCol,
    gridMaxCol: features.gridSize.maxCol,
    gridMinRow: features.gridSize.minRow,
    gridMaxRow: features.gridSize.maxRow,

    connectedSatellites: features.connectedSatellites,
  };

  await prisma.companionFeatures.upsert({
    where: {
      user_id: machineId,
    },
    update: fullDoc,
    create: fullDoc,
  });

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
