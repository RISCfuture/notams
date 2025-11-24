import { logger } from '../config/logger';

export interface RetryOptions {
  maxRetries?: number;
  backoffBase?: number;
  maxBackoff?: number;
  isRetriable?: (error: unknown) => boolean;
}

export interface RetryableError {
  code?: string;
  message?: string;
}

/**
 * Default retriable error detector for database connection errors
 */
export const isRetriableDatabaseError = (error: unknown): boolean => {
  const retriableCodes = [
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now
    '08000', // connection_exception
    '08003', // connection_does_not_exist
    '08006', // connection_failure
    '08P01', // protocol_violation
    '53300', // too_many_connections
  ];

  const retriableMessages = [
    'Connection terminated unexpectedly',
    'connection timeout',
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'Client has encountered a connection error',
  ];

  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const err = error as { code?: string; message?: string };
  return (
    (err.code !== undefined && retriableCodes.includes(err.code)) ||
    retriableMessages.some((msg) => err.message?.includes(msg) ?? false)
  );
};

/**
 * Sleep for the specified number of milliseconds
 */
const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Calculate exponential backoff delay
 */
const calculateBackoff = (attempt: number, base: number, max: number): number => {
  return Math.min(base * Math.pow(2, attempt), max);
};

/**
 * Retry an async operation with exponential backoff
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = parseInt(process.env.DB_MAX_RETRIES || '3', 10),
    backoffBase = parseInt(process.env.DB_RETRY_BACKOFF_BASE || '1000', 10),
    maxBackoff = 10000,
    isRetriable = isRetriableDatabaseError,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      const isLastAttempt = attempt === maxRetries;
      const retriable = isRetriable(error);

      if (!retriable || isLastAttempt) {
        throw error;
      }

      const backoffMs = calculateBackoff(attempt, backoffBase, maxBackoff);
      const errorMessage =
        error && typeof error === 'object' && 'message' in error
          ? (error as { message: string }).message
          : 'Unknown error';

      logger.warn(
        { attempt, backoffMs, error: errorMessage },
        'Operation failed, retrying with exponential backoff'
      );

      await sleep(backoffMs);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError;
}

/**
 * Create a retry wrapper with specific options
 */
export function createRetryWrapper(options: RetryOptions) {
  return <T>(operation: () => Promise<T>): Promise<T> => {
    return withRetry(operation, options);
  };
}
