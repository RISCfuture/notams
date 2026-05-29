import * as Sentry from '@sentry/node'

/** Sentry Crons monitor slug for the NMS ingestion poll loop. */
export const INGEST_MONITOR_SLUG = 'notam-ingest'

/**
 * Send an "ok" heartbeat check-in to Sentry Crons after a successful poll and
 * upsert the monitor's interval schedule so that missed heartbeats alert
 * automatically. No-op when SENTRY_DSN is unset (dev/test).
 *
 * @param pollIntervalMs the ingestion poll interval, used to derive the schedule
 */
export function reportIngestHeartbeat(pollIntervalMs: number): void {
  if (!process.env.SENTRY_DSN) return

  const intervalMinutes = Math.max(1, Math.round(pollIntervalMs / 60000))

  Sentry.captureCheckIn(
    { monitorSlug: INGEST_MONITOR_SLUG, status: 'ok' },
    {
      schedule: { type: 'interval', value: intervalMinutes, unit: 'minute' },
      // Tolerate one fully missed cycle before alerting.
      checkinMargin: intervalMinutes,
      timezone: 'Etc/UTC',
    },
  )
}
