import { Router, Request, Response } from 'express';
import { pool } from '../config/database';
import { logger } from '../config/logger';

const router = Router();

/**
 * Health check endpoint for Fly.io monitoring
 */
router.get('/health', async (_req: Request, res: Response) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: 'unknown',
  };

  try {
    // Check database connection
    await pool.query('SELECT NOW()');
    health.database = 'connected';
    logger.debug('Health check: database connected');
  } catch (error) {
    health.status = 'degraded';
    health.database = 'disconnected';
    logger.error({ error }, 'Health check: database connection failed');
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

export default router;
