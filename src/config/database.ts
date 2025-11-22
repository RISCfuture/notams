import { Pool, PoolConfig } from 'pg';
import { logger } from './logger';

const isTest = process.env.NODE_ENV === 'test';

const getDatabaseUrl = (): string => {
  if (isTest && process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  return process.env.DATABASE_URL;
};

const poolConfig: PoolConfig = {
  connectionString: getDatabaseUrl(),
  max: isTest ? 5 : 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle database client');
});

pool.on('connect', () => {
  logger.debug('New database connection established');
});

export const testConnection = async (): Promise<boolean> => {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    logger.info('Database connection successful');
    return true;
  } catch (error) {
    logger.error({ error }, 'Database connection failed');
    return false;
  }
};

export const closePool = async (): Promise<void> => {
  await pool.end();
  logger.info('Database pool closed');
};
