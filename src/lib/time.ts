/**
 * How often a last-seen style timestamp gets refreshed while a user keeps reporting.
 * Reports arrive hourly, so this avoids rewriting unchanged rows on every report.
 */
export const LAST_SEEN_REFRESH_MS = 4 * 60 * 60 * 1000;

/** Midnight UTC of the given date */
export function getUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

/**
 * Whether a last-seen style timestamp should be refreshed.
 * It is refreshed on the first report of each UTC day (so the day is always accurate),
 * and otherwise once it is older than LAST_SEEN_REFRESH_MS.
 */
export function isLastSeenStale(lastSeen: Date, now: Date): boolean {
  return (
    lastSeen < getUtcDay(now) ||
    now.getTime() - lastSeen.getTime() >= LAST_SEEN_REFRESH_MS
  );
}
