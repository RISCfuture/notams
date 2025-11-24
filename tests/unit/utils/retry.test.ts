import { withRetry, isRetriableDatabaseError, createRetryWrapper } from '../../../src/utils/retry';

describe('Retry Utility', () => {
  describe('isRetriableDatabaseError', () => {
    it('should identify connection terminated error as retriable', () => {
      const error = new Error('Connection terminated unexpectedly');
      expect(isRetriableDatabaseError(error)).toBe(true);
    });

    it('should identify timeout errors as retriable', () => {
      const error = new Error('connection timeout');
      expect(isRetriableDatabaseError(error)).toBe(true);
    });

    it('should identify ECONNRESET as retriable', () => {
      const error = new Error('ECONNRESET');
      expect(isRetriableDatabaseError(error)).toBe(true);
    });

    it('should identify PostgreSQL connection errors as retriable', () => {
      const error = { code: '08006', message: 'connection_failure' };
      expect(isRetriableDatabaseError(error)).toBe(true);
    });

    it('should identify too many connections error as retriable', () => {
      const error = { code: '53300', message: 'too_many_connections' };
      expect(isRetriableDatabaseError(error)).toBe(true);
    });

    it('should not identify constraint violations as retriable', () => {
      const error = { code: '23505', message: 'unique_violation' };
      expect(isRetriableDatabaseError(error)).toBe(false);
    });

    it('should not identify syntax errors as retriable', () => {
      const error = new Error('syntax error at or near "FROM"');
      expect(isRetriableDatabaseError(error)).toBe(false);
    });

    it('should handle non-object errors', () => {
      expect(isRetriableDatabaseError(null)).toBe(false);
      expect(isRetriableDatabaseError(undefined)).toBe(false);
      expect(isRetriableDatabaseError('error')).toBe(false);
    });
  });

  describe('withRetry', () => {
    it('should succeed on first attempt when operation succeeds', async () => {
      let callCount = 0;
      const operation = jest.fn(async () => {
        callCount++;
        return 'success';
      });

      const result = await withRetry(operation);
      expect(result).toBe('success');
      expect(callCount).toBe(1);
    });

    it('should retry on retriable errors', async () => {
      let callCount = 0;
      const operation = jest.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          throw new Error('Connection terminated unexpectedly');
        }
        return 'success';
      });

      const result = await withRetry(operation, { maxRetries: 3 });
      expect(result).toBe('success');
      expect(callCount).toBe(3);
    });

    it('should throw after max retries exceeded', async () => {
      const operation = jest.fn(async () => {
        throw new Error('Connection terminated unexpectedly');
      });

      await expect(withRetry(operation, { maxRetries: 2 })).rejects.toThrow(
        'Connection terminated unexpectedly'
      );
      expect(operation).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should not retry on non-retriable errors', async () => {
      const operation = jest.fn(async () => {
        throw new Error('syntax error');
      });

      await expect(withRetry(operation)).rejects.toThrow('syntax error');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should respect custom isRetriable function', async () => {
      let callCount = 0;
      const operation = jest.fn(async () => {
        callCount++;
        if (callCount <= 1) {
          throw new Error('Custom Error');
        }
        return 'success';
      });

      const customIsRetriable = (error: unknown) => {
        return error instanceof Error && error.message === 'Custom Error';
      };

      const result = await withRetry(operation, {
        maxRetries: 2,
        isRetriable: customIsRetriable,
      });

      expect(result).toBe('success');
      expect(callCount).toBe(2);
    });

    it('should use environment variable for maxRetries', async () => {
      process.env.DB_MAX_RETRIES = '2';
      const operation = jest.fn(async () => {
        throw new Error('ECONNRESET');
      });

      await expect(withRetry(operation, { backoffBase: 10 })).rejects.toThrow();
      expect(operation).toHaveBeenCalledTimes(3); // initial + 2 retries

      delete process.env.DB_MAX_RETRIES;
    });

    it('should use environment variable for backoff base', async () => {
      process.env.DB_RETRY_BACKOFF_BASE = '100';
      let callCount = 0;
      const operation = jest.fn(async () => {
        callCount++;
        if (callCount <= 1) {
          throw new Error('ETIMEDOUT');
        }
        return 'success';
      });

      const startTime = Date.now();
      await withRetry(operation);
      const duration = Date.now() - startTime;

      // Should have waited approximately 100ms (backoff base)
      expect(duration).toBeGreaterThanOrEqual(90);

      delete process.env.DB_RETRY_BACKOFF_BASE;
    });
  });

  describe('createRetryWrapper', () => {
    it('should create a wrapper with custom options', async () => {
      const wrapper = createRetryWrapper({ maxRetries: 1, backoffBase: 50 });

      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('ECONNRESET');
        }
        return 'success';
      };

      const result = await wrapper(operation);
      expect(result).toBe('success');
      expect(callCount).toBe(2);
    });
  });
});
