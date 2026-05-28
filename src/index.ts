import dotenv from 'dotenv'
dotenv.config()

import * as Sentry from '@sentry/node'
import { createServer } from './server'
import { testConnection, closePool, startHealthCheck, stopHealthCheck } from './config/database'
import { logger } from './config/logger'

const PORT = parseInt(process.env.PORT ?? '8080', 10)

// Global error handlers to prevent crashes from unhandled errors
process.on('uncaughtException', (error: Error) => {
  logger.error({ error }, 'Uncaught exception - process will continue')
  Sentry.captureException(error)
})

process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ reason }, 'Unhandled promise rejection')
  Sentry.captureException(reason)
})

async function main() {
  try {
    logger.info('Starting NOTAM web server')

    // Test database connection
    const dbConnected = await testConnection()
    if (!dbConnected) {
      logger.error('Failed to connect to database, exiting')
      process.exit(1)
    }

    // Start database health monitoring
    startHealthCheck()
    logger.info('Database health monitoring started')

    // Create and start Express server
    const app = createServer()
    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info({ port: PORT }, 'HTTP server listening')
    })

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal')

      // Stop accepting new requests
      server.close(() => {
        logger.info('HTTP server closed')
      })

      // Stop health monitoring
      stopHealthCheck()

      // Close database pool
      await closePool()

      logger.info('Graceful shutdown complete')
      process.exit(0)
    }

    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    process.on('SIGINT', () => void shutdown('SIGINT'))
  } catch (error) {
    logger.error({ error }, 'Failed to start service')
    process.exit(1)
  }
}

void main()
