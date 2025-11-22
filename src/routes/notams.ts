import { Router, Response } from 'express';
import { z } from 'zod';
import { NOTAMModel, NOTAMQueryFilters } from '../models/notam';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { logger } from '../config/logger';

const router = Router();
const notamModel = new NOTAMModel();

// Validation schemas
const querySchema = z.object({
  location: z.string().optional(),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  purpose: z.string().optional(),
  scope: z.string().optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).optional(),
  offset: z.string().regex(/^\d+$/).transform(Number).optional(),
});

const notamIdSchema = z.string().min(1);

/**
 * GET /api/notams
 * Query NOTAMs with filters
 */
router.get('/notams', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Validate query parameters
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid query parameters',
        details: parsed.error.issues,
      });
      return;
    }

    const { location, start, end, purpose, scope, limit, offset } = parsed.data;

    const filters: NOTAMQueryFilters = {
      location,
      start: start ? new Date(start) : undefined,
      end: end ? new Date(end) : undefined,
      purpose,
      scope,
      limit: limit || 100,
      offset: offset || 0,
    };

    // Get NOTAMs
    const notams = await notamModel.findByFilters(filters);
    const total = await notamModel.count(filters);

    logger.info(
      {
        tokenName: req.token?.name,
        filters,
        count: notams.length,
      },
      'NOTAMs queried'
    );

    res.json({
      data: notams,
      pagination: {
        total,
        limit: filters.limit,
        offset: filters.offset,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Error querying NOTAMs');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/notams/:notam_id
 * Get single NOTAM by ID
 */
router.get(
  '/notams/:notam_id',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const parsed = notamIdSchema.safeParse(req.params.notam_id);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid NOTAM ID',
          details: parsed.error.issues,
        });
        return;
      }

      const notam = await notamModel.findById(parsed.data);

      if (!notam) {
        res.status(404).json({ error: 'NOTAM not found' });
        return;
      }

      logger.info(
        {
          tokenName: req.token?.name,
          notam_id: parsed.data,
        },
        'NOTAM retrieved'
      );

      res.json({ data: notam });
    } catch (error) {
      logger.error({ error }, 'Error retrieving NOTAM');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
