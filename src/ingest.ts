import dotenv from 'dotenv'
dotenv.config()

import * as Sentry from '@sentry/node'

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  })
}

import express from 'express'
import { testConnection, closePool } from './config/database'
import { logger } from './config/logger'
import { NOTAMIngestionService, INITIAL_LOAD_TIMEOUT_MS } from './services/notam-ingestion'
import { startIngestWatchdog } from './services/ingest-watchdog'
import healthRouter from './routes/health'
import metricsRouter from './routes/metrics'

const PORT = parseInt(process.env.PORT ?? '8080', 10)

process.on('uncaughtException', (error: Error) => {
  logger.error({ error }, 'Uncaught exception - process will continue')
  Sentry.captureException(error)
})

process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ reason }, 'Unhandled promise rejection')
  Sentry.captureException(reason)
})

let ingestionService: NOTAMIngestionService | null = null

async function main(): Promise<void> {
  try {
    logger.info('Starting NOTAM ingestion worker')

    const dbConnected = await testConnection()
    if (!dbConnected) {
      logger.error('Failed to connect to database, exiting')
      process.exit(1)
    }

    if (!process.env.NMS_CLIENT_ID || !process.env.NMS_CLIENT_SECRET) {
      logger.error('NMS credentials not configured; ingestion worker has nothing to do, exiting')
      process.exit(1)
    }

    ingestionService = new NOTAMIngestionService()
    ingestionService.start()
    logger.info('NMS ingestion service started')

    const svc = ingestionService
    // Must exceed the initial-load window: markIngestSuccess() only fires after a poll
    // (or the up-to-INITIAL_LOAD_TIMEOUT_MS initial load) completes, so a fresh worker's
    // first success can legitimately be ~20 min out. A shorter threshold would kill a
    // slow initial load mid-flight and restart-loop. Steady-state polls are far faster.
    const DEFAULT_STALE_THRESHOLD_MS = INITIAL_LOAD_TIMEOUT_MS + 5 * 60 * 1000
    const envStaleThresholdMs = Number(process.env.INGEST_STALE_THRESHOLD_MS)
    const staleThresholdMs =
      Number.isFinite(envStaleThresholdMs) && envStaleThresholdMs > 0
        ? envStaleThresholdMs
        : DEFAULT_STALE_THRESHOLD_MS
    const stopWatchdog = startIngestWatchdog(() => svc.getLastSuccessfulPollTime(), {
      staleThresholdMs,
    })
    logger.info({ staleThresholdMs }, 'Ingestion watchdog started')

    // Minimal HTTP listener: exposes /metrics for Fly's Prometheus scraper and
    // /health for liveness checks. No NOTAMs API and no Sentry/express integration —
    // this process serves no user traffic.
    const app = express()
    app.use('/', metricsRouter)
    app.use('/', healthRouter)
    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info({ port: PORT }, 'Ingest metrics/health endpoint listening')
    })

    const shutdown = async (signal: string): Promise<void> => {
      logger.info({ signal }, 'Received shutdown signal')

      server.close(() => {
        logger.info('Ingest metrics/health endpoint closed')
      })

      stopWatchdog()

      if (ingestionService) {
        ingestionService.stop()
      }

      await closePool()

      logger.info('Graceful shutdown complete')
      process.exit(0)
    }

    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    process.on('SIGINT', () => void shutdown('SIGINT'))
  } catch (error) {
    logger.error({ error }, 'Failed to start ingestion worker')
    process.exit(1)
  }
}

void main()
