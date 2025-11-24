import * as Sentry from '@sentry/node';
import { logger } from '../config/logger';

export interface CircuitBreakerOptions {
  threshold?: number;
  timeout?: number;
  isConnectionError?: (error: unknown) => boolean;
}

export interface CircuitBreakerState {
  failures: number;
  lastFailure: Date | null;
  isOpen: boolean;
}

/**
 * Default connection error detector
 */
export const isConnectionError = (error: unknown): boolean => {
  const connectionErrorMessages = [
    'Connection terminated unexpectedly',
    'connection timeout',
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
  ];

  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const err = error as { message?: string };
  return connectionErrorMessages.some((msg) => err.message?.includes(msg) ?? false);
};

/**
 * Circuit Breaker implementation for preventing cascading failures
 */
export class CircuitBreaker {
  private state: CircuitBreakerState;
  private threshold: number;
  private timeout: number;
  private isConnectionError: (error: unknown) => boolean;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold =
      options.threshold ?? parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '5', 10);
    this.timeout = options.timeout ?? parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT || '60000', 10);
    this.isConnectionError = options.isConnectionError ?? isConnectionError;
    this.state = {
      failures: 0,
      lastFailure: null,
      isOpen: false,
    };
  }

  /**
   * Check if the circuit breaker allows requests to pass through
   */
  isRequestAllowed(): boolean {
    if (!this.state.isOpen) {
      return true;
    }

    const now = new Date();
    const timeSinceLastFailure = now.getTime() - (this.state.lastFailure?.getTime() || 0);

    if (timeSinceLastFailure > this.timeout) {
      this.reset();
      logger.info('Circuit breaker reset after timeout');
      return true;
    }

    return false;
  }

  /**
   * Record a successful operation
   */
  recordSuccess(): void {
    if (this.state.failures > 0) {
      this.state.failures = 0;
      logger.debug('Circuit breaker failure counter reset after success');
    }
  }

  /**
   * Record a failed operation
   */
  recordFailure(error: unknown): void {
    if (!this.isConnectionError(error)) {
      return;
    }

    this.state.failures++;
    this.state.lastFailure = new Date();

    if (this.state.failures >= this.threshold) {
      this.open();
    }
  }

  /**
   * Open the circuit breaker
   */
  private open(): void {
    this.state.isOpen = true;
    logger.error(
      { failures: this.state.failures, threshold: this.threshold },
      'Circuit breaker opened due to repeated connection failures'
    );
    Sentry.captureMessage('Circuit breaker opened', {
      level: 'error',
      tags: {
        failures: this.state.failures,
        threshold: this.threshold,
      },
    });
  }

  /**
   * Reset the circuit breaker to closed state
   */
  private reset(): void {
    this.state.isOpen = false;
    this.state.failures = 0;
  }

  /**
   * Get the current state of the circuit breaker
   */
  getState(): Readonly<CircuitBreakerState> {
    return { ...this.state };
  }

  /**
   * Execute an operation with circuit breaker protection
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.isRequestAllowed()) {
      throw new Error('Circuit breaker is open');
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }
}
