import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/database';
import { logger } from '../config/logger';
import { withRetry } from '../utils/retry';

export interface AuthenticatedRequest extends Request {
  token?: {
    id: number;
    name: string;
  };
}

/**
 * Bearer token authentication middleware
 */
export const authenticateToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    res.status(401).json({ error: 'Invalid authorization header format. Use: Bearer <token>' });
    return;
  }

  const token = parts[1];

  try {
    // Verify token exists and is active in database
    const result = await withRetry(() =>
      pool.query('SELECT id, name FROM api_tokens WHERE token = $1 AND is_active = TRUE', [token])
    );

    if (result.rows.length === 0) {
      logger.warn({ token: token.substring(0, 8) + '...' }, 'Invalid or inactive token');
      res.status(401).json({ error: 'Invalid or inactive token' });
      return;
    }

    // Update last_used_at timestamp (fire-and-forget with retry, don't block auth)
    withRetry(() =>
      pool.query('UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1', [result.rows[0].id])
    ).catch((err) => logger.warn({ err }, 'Failed to update token last_used_at'));

    // Attach token info to request
    req.token = {
      id: result.rows[0].id,
      name: result.rows[0].name,
    };

    logger.debug(
      { tokenId: result.rows[0].id, tokenName: result.rows[0].name },
      'Token authenticated'
    );
    next();
  } catch (error) {
    logger.error({ error }, 'Error authenticating token');
    res.status(500).json({ error: 'Internal server error' });
  }
};
