import dotenv from 'dotenv';
dotenv.config();

import { readFileSync } from 'fs';
import { join } from 'path';
import { pool, closePool, testConnection } from '../config/database';
import { logger } from '../config/logger';

const MIGRATIONS_DIR = join(__dirname, '../../migrations');

const migrations = ['001_create_notams.sql', '002_create_tokens.sql'];

async function runMigrations() {
  try {
    logger.info('Starting database migrations');

    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database');
      process.exit(1);
    }

    // Run each migration
    for (const migration of migrations) {
      logger.info({ migration }, 'Running migration');

      const migrationPath = join(MIGRATIONS_DIR, migration);
      const sql = readFileSync(migrationPath, 'utf-8');

      await pool.query(sql);

      logger.info({ migration }, 'Migration completed');
    }

    logger.info('All migrations completed successfully');

    // Close database connection
    await closePool();

    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error running migrations');
    await closePool();
    process.exit(1);
  }
}

runMigrations();
