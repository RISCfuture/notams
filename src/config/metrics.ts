import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

const isProduction = process.env.NODE_ENV === 'production';

// Create a custom registry (recommended for Fly.io)
export const metricsRegistry = new Registry();

// Only collect default Node.js metrics in production
if (isProduction) {
  collectDefaultMetrics({ register: metricsRegistry });
}

// No-op implementations for non-production environments
const noopCounter = {
  inc: () => {},
  labels: () => noopCounter,
};

const noopHistogram = {
  observe: () => {},
  labels: () => noopHistogram,
  startTimer: () => () => {},
};

const noopGauge = {
  set: () => {},
  inc: () => {},
  dec: () => {},
  labels: () => noopGauge,
};

// ============ INGESTION METRICS ============

export const notamsIngestedTotal = isProduction
  ? new Counter({
      name: 'notams_ingested_total',
      help: 'Total number of NOTAMs successfully ingested',
      labelNames: ['icao_location', 'source_format'] as const,
      registers: [metricsRegistry],
    })
  : (noopCounter as unknown as Counter<'icao_location' | 'source_format'>);

export const notamIngestionDuration = isProduction
  ? new Histogram({
      name: 'notam_ingestion_duration_seconds',
      help: 'Duration of NOTAM ingestion processing in seconds',
      labelNames: ['success'] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [metricsRegistry],
    })
  : (noopHistogram as unknown as Histogram<'success'>);

export const notamParseErrorsTotal = isProduction
  ? new Counter({
      name: 'notam_parse_errors_total',
      help: 'Total number of NOTAM parsing errors',
      labelNames: ['format', 'error_type'] as const,
      registers: [metricsRegistry],
    })
  : (noopCounter as unknown as Counter<'format' | 'error_type'>);

export const notamDuplicatesTotal = isProduction
  ? new Counter({
      name: 'notam_duplicates_total',
      help: 'Total number of duplicate NOTAMs received (upserted)',
      registers: [metricsRegistry],
    })
  : (noopCounter as unknown as Counter<string>);

// ============ API METRICS ============

export const httpRequestsTotal = isProduction
  ? new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'path', 'status_code'] as const,
      registers: [metricsRegistry],
    })
  : (noopCounter as unknown as Counter<'method' | 'path' | 'status_code'>);

export const httpRequestDuration = isProduction
  ? new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'path', 'status_code'] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [metricsRegistry],
    })
  : (noopHistogram as unknown as Histogram<'method' | 'path' | 'status_code'>);

// ============ DATABASE METRICS ============

export const dbPoolConnections = isProduction
  ? new Gauge({
      name: 'db_pool_connections',
      help: 'Current database pool connection counts',
      labelNames: ['state'] as const,
      registers: [metricsRegistry],
    })
  : (noopGauge as unknown as Gauge<'state'>);

export const dbQueryDuration = isProduction
  ? new Histogram({
      name: 'db_query_duration_seconds',
      help: 'Database query duration in seconds',
      labelNames: ['operation', 'success'] as const,
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [metricsRegistry],
    })
  : (noopHistogram as unknown as Histogram<'operation' | 'success'>);

// ============ CIRCUIT BREAKER METRICS ============

export const circuitBreakerState = isProduction
  ? new Gauge({
      name: 'circuit_breaker_state',
      help: 'Circuit breaker state (0=closed, 1=open)',
      labelNames: ['name'] as const,
      registers: [metricsRegistry],
    })
  : (noopGauge as unknown as Gauge<'name'>);

export const circuitBreakerFailuresTotal = isProduction
  ? new Counter({
      name: 'circuit_breaker_failures_total',
      help: 'Total number of failures recorded by circuit breaker',
      labelNames: ['name', 'error_type'] as const,
      registers: [metricsRegistry],
    })
  : (noopCounter as unknown as Counter<'name' | 'error_type'>);

// ============ JMS/SOLACE METRICS ============

export const jmsConnectionStatus = isProduction
  ? new Gauge({
      name: 'jms_connection_status',
      help: 'JMS connection status (1=connected, 0=disconnected)',
      labelNames: ['broker'] as const,
      registers: [metricsRegistry],
    })
  : (noopGauge as unknown as Gauge<'broker'>);

export const jmsMessagesReceivedTotal = isProduction
  ? new Counter({
      name: 'jms_messages_received_total',
      help: 'Total number of JMS messages received',
      labelNames: ['queue'] as const,
      registers: [metricsRegistry],
    })
  : (noopCounter as unknown as Counter<'queue'>);

export const jmsReconnectAttemptsTotal = isProduction
  ? new Counter({
      name: 'jms_reconnect_attempts_total',
      help: 'Total number of JMS reconnection attempts',
      labelNames: ['success'] as const,
      registers: [metricsRegistry],
    })
  : (noopCounter as unknown as Counter<'success'>);
