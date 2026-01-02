import { Request, Response, NextFunction } from 'express';
import { httpRequestsTotal, httpRequestDuration } from '../config/metrics';

/**
 * Normalize path to avoid high cardinality labels.
 * Replaces dynamic segments with placeholders.
 */
const normalizePath = (path: string): string => {
  // Replace NOTAM IDs (e.g., A1234/23, FDC 2/1234) with :notam_id
  let normalized = path.replace(/\/[A-Z]+\d*[\s%20]*\d+\/\d+/gi, '/:notam_id');

  // Replace UUIDs with :id
  normalized = normalized.replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '/:id'
  );

  // Replace numeric IDs with :id
  normalized = normalized.replace(/\/\d+/g, '/:id');

  return normalized;
};

/**
 * Middleware to track HTTP request metrics
 */
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Skip metrics endpoint to avoid recursion
  if (req.path === '/metrics') {
    next();
    return;
  }

  const startTime = process.hrtime.bigint();

  // Hook into response finish
  res.on('finish', () => {
    const endTime = process.hrtime.bigint();
    const durationSeconds = Number(endTime - startTime) / 1e9;

    const normalizedPath = normalizePath(req.path);
    const labels = {
      method: req.method,
      path: normalizedPath,
      status_code: res.statusCode.toString(),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSeconds);
  });

  next();
};
