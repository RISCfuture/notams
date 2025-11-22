import dotenv from 'dotenv';
dotenv.config();

import { NOTAMModel } from '../models/notam';
import { testConnection, closePool } from '../config/database';
import { logger } from '../config/logger';
import * as Sentry from '@sentry/node';

// Initialize Sentry if DSN is provided
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
  });
}

const RETENTION_DAYS = parseInt(process.env.NOTAM_RETENTION_DAYS || '30', 10);

async function pruneExpiredNOTAMs() {
  try {
    logger.info({ retentionDays: RETENTION_DAYS }, 'Starting NOTAM pruning');

    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database');
      process.exit(1);
    }

    // Delete expired NOTAMs
    const notamModel = new NOTAMModel();
    const deletedCount = await notamModel.deleteExpired(RETENTION_DAYS);

    logger.info({ deletedCount, retentionDays: RETENTION_DAYS }, 'NOTAM pruning completed');

    // Close database connection
    await closePool();

    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during NOTAM pruning');
    Sentry.captureException(error);
    await closePool();
    process.exit(1);
  }
}

pruneExpiredNOTAMs();
