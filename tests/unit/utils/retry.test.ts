import {
  withRetry,
  isRetriableDatabaseError,
  isRetriableHttpError,
  createRetryWrapper,
} from '../../../src/utils/retry'

describe('Retry Utility', () => {
  describe('isRetriableDatabaseError', () => {
    it('should identify connection terminated error as retriable', () => {
      const error = new Error('Connection terminated unexpectedly')
      expect(isRetriableDatabaseError(error)).toBe(true)
    })

    it('should identify timeout errors as retriable', () => {
      const error = new Error('connection timeout')
      expect(isRetriableDatabaseError(error)).toBe(true)
    })

    it('should identify ECONNRESET as retriable', () => {
      const error = new Error('ECONNRESET')
      expect(isRetriableDatabaseError(error)).toBe(true)
    })

    it('should identify ETIMEDOUT as retriable', () => {
      const error = new Error('ETIMEDOUT')
      expect(isRetriableDatabaseError(error)).toBe(true)
    })

    it('should identify ECONNREFUSED as retriable', () => {
      const error = new Error('ECONNREFUSED')
      expect(isRetriableDatabaseError(error)).toBe(true)
    })

    it('should identify client connection error messages as retriable', () => {
      const error = new Error('Client has encountered a connection error and is not queryable')
      expect(isRetriableDatabaseError(error)).toBe(true)
    })

    it.each([
      ['57P01', 'admin_shutdown'],
      ['57P02', 'crash_shutdown'],
      ['57P03', 'cannot_connect_now'],
      ['08000', 'connection_exception'],
      ['08003', 'connection_does_not_exist'],
      ['08006', 'connection_failure'],
      ['08P01', 'protocol_violation'],
      ['53300', 'too_many_connections'],
    ])('should identify PostgreSQL code %s (%s) as retriable', (code, message) => {
      const error = { code, message }
      expect(isRetriableDatabaseError(error)).toBe(true)
    })

    it('should not identify constraint violations as retriable', () => {
      const error = { code: '23505', message: 'unique_violation' }
      expect(isRetriableDatabaseError(error)).toBe(false)
    })

    it('should handle non-object errors', () => {
      expect(isRetriableDatabaseError(null)).toBe(false)
      expect(isRetriableDatabaseError(undefined)).toBe(false)
      expect(isRetriableDatabaseError('error')).toBe(false)
    })
  })

  describe('isRetriableHttpError', () => {
    it('identifies TypeError (fetch network failure) as retriable', () => {
      expect(isRetriableHttpError(new TypeError('fetch failed'))).toBe(true)
    })

    it('identifies errors tagged with retriable: true', () => {
      const error = Object.assign(new Error('5xx'), { retriable: true })
      expect(isRetriableHttpError(error)).toBe(true)
    })

    it('does not retry plain errors', () => {
      expect(isRetriableHttpError(new Error('client error'))).toBe(false)
    })

    it('does not retry errors tagged with retriable: false', () => {
      const error = Object.assign(new Error('4xx'), { retriable: false })
      expect(isRetriableHttpError(error)).toBe(false)
    })

    it('handles non-object inputs', () => {
      expect(isRetriableHttpError(null)).toBe(false)
      expect(isRetriableHttpError(undefined)).toBe(false)
      expect(isRetriableHttpError('error')).toBe(false)
      expect(isRetriableHttpError(42)).toBe(false)
    })
  })

  describe('withRetry', () => {
    it('should succeed on first attempt when operation succeeds', async () => {
      let callCount = 0
      const operation = vi.fn(async () => {
        callCount++
        return 'success'
      })

      const result = await withRetry(operation)
      expect(result).toBe('success')
      expect(callCount).toBe(1)
    })

    it('should retry on retriable errors', async () => {
      let callCount = 0
      const operation = vi.fn(async () => {
        callCount++
        if (callCount <= 2) {
          throw new Error('Connection terminated unexpectedly')
        }
        return 'success'
      })

      const result = await withRetry(operation, { maxRetries: 3 })
      expect(result).toBe('success')
      expect(callCount).toBe(3)
    })

    it('should throw after max retries exceeded', async () => {
      const operation = vi.fn(async () => {
        throw new Error('Connection terminated unexpectedly')
      })

      await expect(withRetry(operation, { maxRetries: 2 })).rejects.toThrow(
        'Connection terminated unexpectedly',
      )
      expect(operation).toHaveBeenCalledTimes(3) // initial + 2 retries
    })

    it('should not retry on non-retriable errors', async () => {
      const operation = vi.fn(async () => {
        throw new Error('syntax error')
      })

      await expect(withRetry(operation)).rejects.toThrow('syntax error')
      expect(operation).toHaveBeenCalledTimes(1)
    })

    it.each([
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'connection timeout',
      'Connection terminated unexpectedly',
      'Client has encountered a connection error and is not queryable',
    ])('should retry and eventually succeed for error message: %s', async (message) => {
      let callCount = 0
      const operation = vi.fn(async () => {
        callCount++
        if (callCount <= 2) {
          throw new Error(message)
        }
        return 'success'
      })

      const result = await withRetry(operation, { maxRetries: 3, backoffBase: 10 })
      expect(result).toBe('success')
      expect(callCount).toBe(3)
    })

    it('should respect custom isRetriable function', async () => {
      let callCount = 0
      const operation = vi.fn(async () => {
        callCount++
        if (callCount <= 1) {
          throw new Error('Custom Error')
        }
        return 'success'
      })

      const customIsRetriable = (error: unknown) => {
        return error instanceof Error && error.message === 'Custom Error'
      }

      const result = await withRetry(operation, {
        maxRetries: 2,
        isRetriable: customIsRetriable,
      })

      expect(result).toBe('success')
      expect(callCount).toBe(2)
    })

    it('should use environment variable for maxRetries', async () => {
      process.env.DB_MAX_RETRIES = '2'
      const operation = vi.fn(async () => {
        throw new Error('ECONNRESET')
      })

      await expect(withRetry(operation, { backoffBase: 10 })).rejects.toThrow()
      expect(operation).toHaveBeenCalledTimes(3) // initial + 2 retries

      delete process.env.DB_MAX_RETRIES
    })

    it('should use environment variable for backoff base', async () => {
      process.env.DB_RETRY_BACKOFF_BASE = '100'
      let callCount = 0
      const operation = vi.fn(async () => {
        callCount++
        if (callCount <= 1) {
          throw new Error('ETIMEDOUT')
        }
        return 'success'
      })

      const startTime = Date.now()
      await withRetry(operation)
      const duration = Date.now() - startTime

      // Should have waited approximately 100ms (backoff base)
      expect(duration).toBeGreaterThanOrEqual(90)

      delete process.env.DB_RETRY_BACKOFF_BASE
    })
  })

  describe('createRetryWrapper', () => {
    it('should create a wrapper with custom options', async () => {
      const wrapper = createRetryWrapper({ maxRetries: 1, backoffBase: 50 })

      let callCount = 0
      const operation = async () => {
        callCount++
        if (callCount === 1) {
          throw new Error('ECONNRESET')
        }
        return 'success'
      }

      const result = await wrapper(operation)
      expect(result).toBe('success')
      expect(callCount).toBe(2)
    })
  })
})
