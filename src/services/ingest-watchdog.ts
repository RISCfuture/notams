import * as Sentry from '@sentry/node'
import { logger } from '../config/logger'

export interface IngestWatchdogOptions {
  /** Max time without a successful poll before the worker is considered wedged. */
  staleThresholdMs?: number
  /** How often to evaluate staleness. */
  checkIntervalMs?: number
  /** Called once when staleness is detected. Defaults to capture-to-Sentry + exit(1). */
  onStale?: (secondsSinceLastSuccess: number) => void | Promise<void>
}

// Fallback only — the production caller (ingest.ts) always passes an explicit
// threshold derived from the initial-load timeout. Kept so the module is usable
// standalone (and in tests) without an option.
const FALLBACK_STALE_THRESHOLD_MS = 15 * 60 * 1000
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000

/**
 * Watch ingestion freshness. If no successful poll has occurred within the
 * threshold (measured from the last success, or from watchdog start if there has
 * never been one), invoke `onStale` exactly once. The default `onStale` reports to
 * Sentry and exits the process non-zero so Fly's restart policy relaunches it.
 *
 * @returns a stop function that clears the timer.
 */
export function startIngestWatchdog(
  getLastSuccess: () => Date | null,
  options: IngestWatchdogOptions = {},
): () => void {
  const staleThresholdMs = options.staleThresholdMs ?? FALLBACK_STALE_THRESHOLD_MS
  const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
  const onStale = options.onStale ?? defaultOnStale
  const startedAt = Date.now()
  let fired = false

  const timer = setInterval(() => {
    if (fired) return
    const last = getLastSuccess()
    const referenceMs = last ? last.getTime() : startedAt
    const elapsedMs = Date.now() - referenceMs
    if (elapsedMs > staleThresholdMs) {
      fired = true
      clearInterval(timer)
      void onStale(Math.round(elapsedMs / 1000))
    }
  }, checkIntervalMs)

  // The watchdog must not keep the process alive on its own.
  if (typeof timer.unref === 'function') timer.unref()

  return () => {
    clearInterval(timer)
  }
}

async function defaultOnStale(secondsSinceLastSuccess: number): Promise<void> {
  logger.fatal({ secondsSinceLastSuccess }, 'Ingestion stalled — exiting for Fly restart')
  try {
    Sentry.captureException(new Error('Ingestion stalled; exiting for restart'), {
      tags: { error_type: 'ingest_watchdog' },
      extra: { secondsSinceLastSuccess },
    })
    await Sentry.flush(2000)
  } finally {
    process.exit(1)
  }
}
