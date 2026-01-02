import { Router, Request, Response } from 'express';
import { metricsRegistry } from '../config/metrics';
import { logger } from '../config/logger';

const router = Router();

/**
 * Prometheus metrics endpoint
 * No authentication required - intended for internal scraping by Fly.io
 */
router.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const metrics = await metricsRegistry.metrics();
    res.set('Content-Type', metricsRegistry.contentType);
    res.send(metrics);
  } catch (error) {
    logger.error({ error }, 'Error generating metrics');
    res.status(500).send('Error generating metrics');
  }
});

export default router;
