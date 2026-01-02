import { Pool, PoolConfig } from 'pg';
import * as Sentry from '@sentry/node';
import { logger } from './logger';
import { dbPoolConnections } from './metrics';

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

const getPoolConfig = (): PoolConfig => {
  const maxConnections = parseInt(process.env.DB_POOL_MAX || '30', 10);
  const idleTimeout = parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '60000', 10);
  const connectionTimeout = parseInt(process.env.DB_CONNECTION_TIMEOUT || '30000', 10);
  const statementTimeout = parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10);

  return {
    connectionString: getDatabaseUrl(),
    max: isTest ? 5 : maxConnections,
    idleTimeoutMillis: idleTimeout,
    connectionTimeoutMillis: connectionTimeout,
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    // Allow pool to cleanly remove idle clients that have errored
    allowExitOnIdle: true,
  };
};

const poolConfig: PoolConfig = getPoolConfig();

export const pool = new Pool(poolConfig);

// Update pool connection metrics
const updatePoolMetrics = (): void => {
  dbPoolConnections.set({ state: 'total' }, pool.totalCount);
  dbPoolConnections.set({ state: 'idle' }, pool.idleCount);
  dbPoolConnections.set({ state: 'waiting' }, pool.waitingCount);
};

// Handle errors on idle clients in the pool
// This prevents connection termination errors from crashing the process
pool.on('error', (err, _client) => {
  logger.error(
    {
      err,
      poolStats: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    },
    'Unexpected error on idle database client'
  );
  Sentry.captureException(err, {
    tags: { component: 'database-pool' },
    extra: {
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
      poolWaiting: pool.waitingCount,
    },
  });
});

pool.on('connect', () => {
  logger.debug('New database connection established');
  updatePoolMetrics();
});

pool.on('acquire', () => {
  updatePoolMetrics();
});

pool.on('release', () => {
  updatePoolMetrics();
});

pool.on('remove', () => {
  updatePoolMetrics();
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

export const getPoolStats = () => ({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
});

let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

export const startHealthCheck = (): void => {
  if (healthCheckInterval) {
    return;
  }

  healthCheckInterval = setInterval(async () => {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      logger.debug({ poolStats: getPoolStats() }, 'Pool health check passed');
    } catch (error) {
      logger.error({ error, poolStats: getPoolStats() }, 'Pool health check failed');
    }
  }, 30000);
};

export const stopHealthCheck = (): void => {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
};
