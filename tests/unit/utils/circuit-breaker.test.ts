import { CircuitBreaker, isConnectionError } from '../../../src/utils/circuit-breaker';

describe('Circuit Breaker Utility', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ threshold: 3, timeout: 5000 });
  });

  describe('isConnectionError', () => {
    it('should identify connection terminated error', () => {
      const error = new Error('Connection terminated unexpectedly');
      expect(isConnectionError(error)).toBe(true);
    });

    it('should identify timeout errors', () => {
      const error = new Error('connection timeout');
      expect(isConnectionError(error)).toBe(true);
    });

    it('should identify ECONNRESET', () => {
      const error = new Error('ECONNRESET');
      expect(isConnectionError(error)).toBe(true);
    });

    it('should identify ETIMEDOUT', () => {
      const error = new Error('ETIMEDOUT');
      expect(isConnectionError(error)).toBe(true);
    });

    it('should identify ECONNREFUSED', () => {
      const error = new Error('ECONNREFUSED');
      expect(isConnectionError(error)).toBe(true);
    });

    it('should not identify other errors', () => {
      const error = new Error('Some business logic error');
      expect(isConnectionError(error)).toBe(false);
    });

    it('should handle non-object errors', () => {
      expect(isConnectionError(null)).toBe(false);
      expect(isConnectionError(undefined)).toBe(false);
      expect(isConnectionError('error')).toBe(false);
    });
  });

  describe('isRequestAllowed', () => {
    it('should return true when circuit is closed', () => {
      expect(breaker.isRequestAllowed()).toBe(true);
    });

    it('should return false when circuit is open', () => {
      // Force circuit to open
      const error = new Error('Connection terminated unexpectedly');
      breaker.recordFailure(error);
      breaker.recordFailure(error);
      breaker.recordFailure(error);

      expect(breaker.isRequestAllowed()).toBe(false);
    });

    it('should reset circuit breaker after timeout', async () => {
      // Open the circuit
      const error = new Error('ECONNRESET');
      breaker.recordFailure(error);
      breaker.recordFailure(error);
      breaker.recordFailure(error);

      expect(breaker.isRequestAllowed()).toBe(false);

      // Wait for timeout + a bit more
      await new Promise((resolve) => setTimeout(resolve, 5100));

      expect(breaker.isRequestAllowed()).toBe(true);
      const state = breaker.getState();
      expect(state.isOpen).toBe(false);
      expect(state.failures).toBe(0);
    });

    it('should not reset before timeout', () => {
      const error = new Error('connection timeout');
      breaker.recordFailure(error);
      breaker.recordFailure(error);
      breaker.recordFailure(error);

      expect(breaker.isRequestAllowed()).toBe(false);

      const state = breaker.getState();
      expect(state.isOpen).toBe(true);
    });
  });

  describe('recordFailure', () => {
    it('should increment failure count on connection error', () => {
      const error = new Error('Connection terminated unexpectedly');
      breaker.recordFailure(error);

      const state = breaker.getState();
      expect(state.failures).toBe(1);
      expect(state.lastFailure).toBeInstanceOf(Date);
    });

    it('should not increment failure count on non-connection error', () => {
      const error = new Error('Some other error');
      breaker.recordFailure(error);

      const state = breaker.getState();
      expect(state.failures).toBe(0);
      expect(state.lastFailure).toBeNull();
    });

    it('should open circuit breaker after threshold failures', () => {
      const error = new Error('Connection terminated unexpectedly');

      breaker.recordFailure(error);
      breaker.recordFailure(error);
      expect(breaker.getState().isOpen).toBe(false);

      breaker.recordFailure(error);
      expect(breaker.getState().isOpen).toBe(true);
      expect(breaker.getState().failures).toBe(3);
    });

    it('should handle ETIMEDOUT errors', () => {
      const error = new Error('ETIMEDOUT');
      breaker.recordFailure(error);

      expect(breaker.getState().failures).toBe(1);
    });

    it('should handle ECONNRESET errors', () => {
      const error = new Error('ECONNRESET');
      breaker.recordFailure(error);

      expect(breaker.getState().failures).toBe(1);
    });

    it('should handle connection timeout errors', () => {
      const error = new Error('connection timeout');
      breaker.recordFailure(error);

      expect(breaker.getState().failures).toBe(1);
    });
  });

  describe('recordSuccess', () => {
    it('should reset failure counter after success', () => {
      const error = new Error('ECONNRESET');
      breaker.recordFailure(error);
      breaker.recordFailure(error);

      expect(breaker.getState().failures).toBe(2);

      breaker.recordSuccess();
      expect(breaker.getState().failures).toBe(0);
    });

    it('should do nothing if no failures recorded', () => {
      breaker.recordSuccess();
      expect(breaker.getState().failures).toBe(0);
    });

    it('should not close open circuit breaker immediately', () => {
      const error = new Error('connection timeout');
      breaker.recordFailure(error);
      breaker.recordFailure(error);
      breaker.recordFailure(error);

      expect(breaker.getState().isOpen).toBe(true);

      breaker.recordSuccess();
      expect(breaker.getState().failures).toBe(0);
      expect(breaker.getState().isOpen).toBe(true); // Still open
    });
  });

  describe('execute', () => {
    it('should execute operation when circuit is closed', async () => {
      const operation = jest.fn(async () => 'success');
      const result = await breaker.execute(operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should throw error when circuit is open', async () => {
      // Open the circuit
      const error = new Error('ECONNRESET');
      breaker.recordFailure(error);
      breaker.recordFailure(error);
      breaker.recordFailure(error);

      const operation = jest.fn(async () => 'success');

      await expect(breaker.execute(operation)).rejects.toThrow('Circuit breaker is open');
      expect(operation).not.toHaveBeenCalled();
    });

    it('should record success automatically', async () => {
      const error = new Error('connection timeout');
      breaker.recordFailure(error);
      expect(breaker.getState().failures).toBe(1);

      const operation = jest.fn(async () => 'success');
      await breaker.execute(operation);

      expect(breaker.getState().failures).toBe(0);
    });

    it('should record failure automatically', async () => {
      const operation = jest.fn(async () => {
        throw new Error('ETIMEDOUT');
      });

      await expect(breaker.execute(operation)).rejects.toThrow('ETIMEDOUT');
      expect(breaker.getState().failures).toBe(1);
    });
  });

  describe('environment variable configuration', () => {
    it('should respect CIRCUIT_BREAKER_THRESHOLD', () => {
      process.env.CIRCUIT_BREAKER_THRESHOLD = '10';
      const testBreaker = new CircuitBreaker();

      const error = new Error('connection timeout');
      for (let i = 0; i < 9; i++) {
        testBreaker.recordFailure(error);
      }
      expect(testBreaker.getState().isOpen).toBe(false);

      testBreaker.recordFailure(error);
      expect(testBreaker.getState().isOpen).toBe(true);

      delete process.env.CIRCUIT_BREAKER_THRESHOLD;
    });

    it('should respect CIRCUIT_BREAKER_TIMEOUT', async () => {
      process.env.CIRCUIT_BREAKER_TIMEOUT = '1000';
      const testBreaker = new CircuitBreaker();

      const error = new Error('ECONNRESET');
      testBreaker.recordFailure(error);
      testBreaker.recordFailure(error);
      testBreaker.recordFailure(error);
      testBreaker.recordFailure(error);
      testBreaker.recordFailure(error);

      expect(testBreaker.isRequestAllowed()).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(testBreaker.isRequestAllowed()).toBe(true);

      delete process.env.CIRCUIT_BREAKER_TIMEOUT;
    });

    it('should use defaults when env vars not set', () => {
      delete process.env.CIRCUIT_BREAKER_THRESHOLD;
      delete process.env.CIRCUIT_BREAKER_TIMEOUT;
      const testBreaker = new CircuitBreaker();

      const error = new Error('connection timeout');
      for (let i = 0; i < 4; i++) {
        testBreaker.recordFailure(error);
      }
      expect(testBreaker.getState().isOpen).toBe(false);

      testBreaker.recordFailure(error);
      expect(testBreaker.getState().isOpen).toBe(true);
    });
  });

  describe('getState', () => {
    it('should return readonly copy of state', () => {
      const state1 = breaker.getState();
      const state2 = breaker.getState();

      expect(state1).not.toBe(state2); // Different objects
      expect(state1).toEqual(state2); // But same values
    });
  });
});
