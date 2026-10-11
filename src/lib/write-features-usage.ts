import type { DetailedUsageFeaturesType } from "../detailed-usage.js";
import type { CompanionFeatures, PrismaClient } from "../prisma/client.js";
import type { UpdatesBodyType } from "../update.js";
import { isUniqueConstraintError, type Complete } from "./types.js";
import { isLastSeenStale } from "./time.js";

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

    // Clamp lengths to not overflow the table columns
    app_version: app.version.slice(0, 16),
    app_build: app.build.slice(0, 255),

    os_platform: os.platform.slice(0, 16),
    os_release: os.release.slice(0, 48),
    os_arch: os.arch.slice(0, 8),

    // General feature flags
    isBoundToLoopback: features.isBoundToLoopback,
    hasAdminPassword: features.hasAdminPassword,
    hasPincodeLockout: features.hasPincodeLockout,
    cloudEnabled: features.cloudEnabled,
    httpsEnabled: features.httpsEnabled,

    // New fields default to null ("unknown") when not reported by older clients
    buttonDecoration: features.buttonDecoration ?? null,
    buttonStatusIcons: features.buttonStatusIcons ?? null,

    // Protocol usage
    httpEnabled: features.httpEnabled ?? null,
    httpDeprecatedEnabled: features.httpDeprecatedEnabled ?? null,
    tcpEnabled: features.tcpEnabled,
    tcpDeprecatedEnabled: features.tcpDeprecatedEnabled,
    udpEnabled: features.udpEnabled,
    udpDeprecatedEnabled: features.udpDeprecatedEnabled,
    oscEnabled: features.oscEnabled,
    oscDeprecatedEnabled: features.oscDeprecatedEnabled,
    rossTalkEnabled: features.rossTalkEnabled,
    emberPlusEnabled: features.emberPlusEnabled,
    artnetEnabled: features.artnetEnabled,

    satelliteSubscriptionsEnabled: features.satelliteSubscriptionsEnabled ?? null,
    mdnsAnnouncementsEnabled: features.mdnsAnnouncementsEnabled ?? null,

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

    imageLibraryCount: features.imageLibraryCount ?? null,
    enabledBackupRuleCount: features.enabledBackupRuleCount ?? null,

    restApiEnabled: features.restApiEnabled ?? null,
    apiKeyCount: features.apiKeyCount ?? null,
    prometheusEnabled: features.prometheusEnabled ?? null,

    pageVariableCount: features.pageVariableCount ?? null,
    buttonReferenceCount: features.buttonReferenceCount ?? null,
    presetReferenceCount: features.presetReferenceCount ?? null,

    defaultExportFormat: features.defaultExportFormat ?? null,
  };

  const existing = await prisma.companionFeatures.findUnique({
    where: {
      user_id: machineId,
    },
  });

  if (!existing) {
    try {
      await prisma.companionFeatures.createMany({ data: fullDoc });
    } catch (e) {
      // Created concurrently by another request
      if (!isUniqueConstraintError(e)) throw e;
      await prisma.companionFeatures.updateMany({
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

  await prisma.companionFeatures.updateMany({
    where: {
      id: existing.id,
    },
    data: fullDoc,
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
