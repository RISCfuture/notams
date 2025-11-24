import dotenv from 'dotenv';
dotenv.config();

import { createServer } from './server';
import { testConnection, closePool, startHealthCheck, stopHealthCheck } from './config/database';
import { logger } from './config/logger';
import { NOTAMIngestionService } from './services/notam-ingestion';

const PORT = process.env.PORT || 8080;

let ingestionService: NOTAMIngestionService | null = null;

async function main() {
  try {
    logger.info('Starting NOTAM service');

    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database, exiting');
      process.exit(1);
    }

    // Start database health monitoring
    startHealthCheck();
    logger.info('Database health monitoring started');

    // Create and start Express server
    const app = createServer();
    const server = app.listen(PORT, () => {
      logger.info({ port: PORT }, 'HTTP server listening');
    });

    // Start JMS ingestion service (only if credentials are configured)
    if (process.env.JMS_USERNAME && process.env.JMS_PASSWORD) {
      try {
        ingestionService = new NOTAMIngestionService();
        await ingestionService.start();
        logger.info('JMS ingestion service started');
      } catch (error) {
        logger.error({ error }, 'Failed to start JMS ingestion service, continuing with API only');
      }
    } else {
      logger.warn('JMS credentials not configured, ingestion service not started');
    }

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');

      // Stop accepting new requests
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // Stop ingestion service
      if (ingestionService) {
        await ingestionService.stop();
      }

      // Stop health monitoring
      stopHealthCheck();

      // Close database pool
      await closePool();

      logger.info('Graceful shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error({ error }, 'Failed to start service');
    process.exit(1);
  }
}

main();
