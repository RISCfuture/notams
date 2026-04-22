import * as Sentry from '@sentry/node'
import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { SaxesParser } from 'saxes'
import type { SaxesTagPlain } from 'saxes'
import { getNMSConfig, NMSTokenProvider } from '../config/nms'
import type { NMSConfig } from '../config/nms'
import { logger } from '../config/logger'
import { getPoolStats } from '../config/database'
import { NOTAMParser } from './notam-parser'
import { nmsRequest, NMSHttpError } from './nms-client'
import { NOTAMModel } from '../models/notam'
import { IngestionStateModel } from '../models/ingestion-state'
import { CircuitBreaker } from '../utils/circuit-breaker'
import type { NOTAM } from '../models/notam'
import {
  ingestionConnectionStatus,
  ingestionMessagesReceivedTotal,
  notamsIngestedTotal,
  notamIngestionDuration,
  ingestionPollDuration,
  circuitBreakerState,
  circuitBreakerFailuresTotal,
} from '../config/metrics'

/** Chunk size for streaming initial-load upserts. Keeps peak memory bounded. */
const INITIAL_LOAD_BATCH_SIZE = 500

/** Local name of the element that wraps a single NOTAM's AIXM payload. */
const AIXM_MESSAGE_LOCAL_NAME = 'AIXMBasicMessage'

/** Delta polling can't catch up if gap exceeds this; trigger a full initial load instead. */
const MAX_DELTA_GAP_MS = 23 * 60 * 60 * 1000

/**
 * Abort the initial-load download+stream if it doesn't complete in this window.
 * Prevents the poll loop from hanging forever when Apigee/GCS silently stops
 * delivering bytes mid-stream (Node fetch has no default read timeout, so the
 * for-await iterator would otherwise never resolve or reject). A failed/aborted
 * poll flips the circuit breaker and the next 5-min poll retries with a fresh
 * signed URL.
 */
const INITIAL_LOAD_TIMEOUT_MS = 20 * 60 * 1000

type SourceFormat = 'geojson' | 'aixm'

/** Strip any XML namespace prefix (e.g. "aixm:AIXMBasicMessage" -> "AIXMBasicMessage"). */
function localName(qualifiedName: string): string {
  const colon = qualifiedName.indexOf(':')
  return colon === -1 ? qualifiedName : qualifiedName.slice(colon + 1)
}

const XML_TEXT_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const XML_ATTR_ESCAPES: Record<string, string> = { ...XML_TEXT_ESCAPES, '"': '&quot;' }

/** XML-escape element text content. */
function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (c) => XML_TEXT_ESCAPES[c] ?? c)
}

/** XML-escape an attribute value (also escapes quotes). */
function escapeAttr(value: string): string {
  return value.replace(/[&<>"]/g, (c) => XML_ATTR_ESCAPES[c] ?? c)
}

/** Re-serialize a SAX opentag event back into XML. */
function serializeOpenTag(tag: SaxesTagPlain): string {
  const attrs = Object.entries(tag.attributes)
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join('')
  return `<${tag.name}${attrs}${tag.isSelfClosing ? '/' : ''}>`
}

export class NOTAMIngestionService {
  private parser: NOTAMParser
  private notamModel: NOTAMModel
  private stateModel: IngestionStateModel
  private isRunning = false
  private circuitBreaker: CircuitBreaker
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private immediateRetryTimer: ReturnType<typeof setTimeout> | null = null
  private immediateRetryPending = false
  private lastPollTime: Date | null = null
  private pollIntervalMs: number
  private tokenProvider: NMSTokenProvider

  constructor() {
    this.parser = new NOTAMParser()
    this.notamModel = new NOTAMModel()
    this.stateModel = new IngestionStateModel()
    this.circuitBreaker = new CircuitBreaker()
    const config = getNMSConfig()
    this.pollIntervalMs = config.pollIntervalMs
    this.tokenProvider = new NMSTokenProvider(config)

    logger.info('NMS ingestion service initialized')
  }

  start(): void {
    if (this.isRunning) {
      logger.warn('Ingestion service already running')
      return
    }

    this.isRunning = true
    ingestionConnectionStatus.set({ source: 'nms' }, 1)
    logger.info('Starting NMS polling ingestion service')

    void this.poll()
  }

  private async poll(): Promise<void> {
    if (!this.isRunning) return

    const pollStart = process.hrtime.bigint()

    const cbState = this.circuitBreaker.getState()
    circuitBreakerState.set({ name: 'ingestion' }, cbState.isOpen ? 1 : 0)

    if (!this.circuitBreaker.isRequestAllowed()) {
      logger.warn({ circuitBreakerState: cbState }, 'Circuit breaker open, skipping poll cycle')
      this.scheduleNextPoll()
      return
    }

    // Capture before the fetch so we don't skip NOTAMs that land between the request
    // being sent and the response arriving.
    const pollStartedAt = new Date()

    try {
      const config = getNMSConfig()
      const [token, stored] = await Promise.all([
        this.tokenProvider.getAccessToken(),
        this.lastPollTime === null ? this.stateModel.getLastPollTime() : Promise.resolve(null),
      ])

      if (this.lastPollTime === null && stored) {
        this.lastPollTime = stored
        logger.info(
          { lastPollTime: this.lastPollTime.toISOString() },
          'Restored last poll time from database',
        )
      }

      if (
        !this.lastPollTime ||
        pollStartedAt.getTime() - this.lastPollTime.getTime() > MAX_DELTA_GAP_MS
      ) {
        await this.runInitialLoad(config, token, pollStartedAt)
        return
      }

      const url = new URL(`${config.baseUrl}/nmsapi/v1/notams`)
      url.searchParams.set('lastUpdatedDate', this.lastPollTime.toISOString())

      logger.info({ url: url.toString() }, 'Polling NMS API')

      let data: { geojson?: unknown[] }
      try {
        const envelope = await nmsRequest<{ geojson?: unknown[] }>(url.toString(), token, {
          headers: { nmsResponseFormat: 'GEOJSON' },
        })
        data = envelope.data
      } catch (error) {
        if (error instanceof NMSHttpError && error.status === 401) {
          logger.warn('NMS API returned 401, token may be expired')
          this.tokenProvider.resetCache()

          if (!this.immediateRetryPending) {
            // Fast-path: retry immediately once with a fresh token instead of waiting a
            // full poll interval. scheduleNextPoll() in the finally block will skip
            // since immediateRetryTimer is set.
            this.immediateRetryPending = true
            this.immediateRetryTimer = setTimeout(() => {
              this.immediateRetryTimer = null
              void this.poll()
            }, 0)
          } else {
            logger.warn(
              'NMS API returned 401 on immediate retry, falling back to normal poll interval',
            )
            this.immediateRetryPending = false
          }
          return
        }
        throw error
      }

      const features = data.geojson ?? []
      ingestionMessagesReceivedTotal.inc({ source: 'nms' }, features.length)

      logger.info({ count: features.length }, 'Received NOTAMs from NMS API')

      const parsedNotams: NOTAM[] = []
      for (const feature of features) {
        const notam = this.parser.parseGeoJSONFeature(feature)
        if (notam) {
          parsedNotams.push(notam)
        }
      }

      await this.upsertBatch(parsedNotams, 'geojson', features.length)

      this.circuitBreaker.recordSuccess()
      this.immediateRetryPending = false
      this.lastPollTime = pollStartedAt
      // Only persist on non-empty polls. After a restart following empty polls the
      // persisted value will be behind the in-memory pointer; that's idempotent — the
      // next non-empty poll catches the DB up.
      if (features.length > 0) {
        await this.stateModel.setLastPollTime(pollStartedAt)
      }
      ingestionConnectionStatus.set({ source: 'nms' }, 1)
    } catch (error) {
      logger.error({ error }, 'Error during NMS poll cycle')

      // Reset the fast-retry flag — non-401 errors shouldn't leave it sticky and
      // block a future 401 from getting its fast retry.
      this.immediateRetryPending = false

      this.circuitBreaker.recordFailure(error)
      circuitBreakerFailuresTotal.inc({ name: 'ingestion', error_type: 'poll' })

      const newCbState = this.circuitBreaker.getState()
      circuitBreakerState.set({ name: 'ingestion' }, newCbState.isOpen ? 1 : 0)

      Sentry.captureException(error, {
        tags: {
          error_type: 'nms_poll',
          circuit_breaker_open: String(newCbState.isOpen),
          circuit_breaker_failures: String(newCbState.failures),
        },
        contexts: {
          database: {
            pool_stats: getPoolStats(),
          },
        },
      })

      ingestionConnectionStatus.set({ source: 'nms' }, 0)
    } finally {
      const duration = Number(process.hrtime.bigint() - pollStart) / 1e9
      ingestionPollDuration.observe({ source: 'nms' }, duration)

      this.scheduleNextPoll()
    }
  }

  private async upsertBatch(
    parsedNotams: NOTAM[],
    sourceFormat: SourceFormat,
    totalReceived: number,
  ): Promise<void> {
    if (parsedNotams.length === 0) return

    const batchStart = process.hrtime.bigint()
    let success = 'true'

    try {
      const { inserted, updated } = await this.notamModel.createBatch(parsedNotams)
      notamsIngestedTotal.inc(
        { icao_location: 'all', source_format: sourceFormat },
        inserted + updated,
      )
      logger.info(
        {
          total: parsedNotams.length,
          inserted,
          updated,
          skipped: totalReceived - parsedNotams.length,
          sourceFormat,
        },
        'Batch ingestion completed',
      )
    } catch (error) {
      success = 'false'
      throw error
    } finally {
      const duration = Number(process.hrtime.bigint() - batchStart) / 1e9
      notamIngestionDuration.observe({ success }, duration)
    }
  }

  private async runInitialLoad(
    config: NMSConfig,
    token: string,
    pollStartedAt: Date,
  ): Promise<void> {
    logger.info('Running initial load — delta poll gap too large or no previous poll')

    // allowRedirect=true lets Apigee redirect internally to the signed content URL
    // in one API call. The allowRedirect=false split (2 back-to-back calls to
    // /notams/il + /v1/content/...) trips the prod 1 msg/sec spike arrest policy.
    const contentResponse = await nmsRequest(
      `${config.baseUrl}/nmsapi/v1/notams/il?allowRedirect=true`,
      token,
      { raw: true, signal: AbortSignal.timeout(INITIAL_LOAD_TIMEOUT_MS) },
    )
    if (!contentResponse.body) {
      throw new Error('NMS initial load content response has no body')
    }

    const stats = await this.streamInitialLoadContent(contentResponse.body)

    this.lastPollTime = pollStartedAt
    await this.stateModel.setLastPollTime(pollStartedAt)

    this.circuitBreaker.recordSuccess()
    this.immediateRetryPending = false
    ingestionConnectionStatus.set({ source: 'nms' }, 1)

    logger.info(
      {
        totalMessages: stats.totalMessages,
        parsed: stats.parsed,
        parseFailures: stats.parseFailures,
        upserted: stats.upserted,
      },
      'Initial load completed',
    )
  }

  /**
   * Stream the gzipped AIXM content body through a SAX parser and upsert NOTAMs
   * in chunks of INITIAL_LOAD_BATCH_SIZE. Peak memory stays bounded regardless of
   * payload size.
   */
  private async streamInitialLoadContent(
    body: ReadableStream<Uint8Array>,
  ): Promise<{ totalMessages: number; parsed: number; parseFailures: number; upserted: number }> {
    const stats = { totalMessages: 0, parsed: 0, parseFailures: 0, upserted: 0 }
    const pendingNotams: NOTAM[] = []
    const completedMessages: string[] = []

    const saxParser = new SaxesParser({ xmlns: false })
    // messageDepth counts open elements inside the current AIXMBasicMessage;
    // 0 means we're outside any message.
    let messageDepth = 0
    let messageXmlParts: string[] = []
    // Wrapped so reassignment in event handlers survives TS narrowing.
    const errorRef: { err: Error | null } = { err: null }

    saxParser.on('opentag', (tag: SaxesTagPlain) => {
      const isMessageRoot = messageDepth === 0 && localName(tag.name) === AIXM_MESSAGE_LOCAL_NAME

      if (!isMessageRoot && messageDepth === 0) return

      if (isMessageRoot) messageXmlParts = []
      messageXmlParts.push(serializeOpenTag(tag))
      // Saxes fires closetag for self-closing tags too, so always increment; decrement
      // symmetrically in the closetag handler keeps the counter balanced.
      messageDepth += 1
    })

    saxParser.on('text', (text: string) => {
      if (messageDepth > 0) messageXmlParts.push(escapeText(text))
    })

    saxParser.on('cdata', (cdata: string) => {
      if (messageDepth > 0) messageXmlParts.push(`<![CDATA[${cdata}]]>`)
    })

    saxParser.on('closetag', (tag: SaxesTagPlain) => {
      if (messageDepth === 0) return
      // Don't serialize the closing tag for self-closing elements — serializeOpenTag
      // already emitted "<foo/>" with the self-close marker.
      if (!tag.isSelfClosing) messageXmlParts.push(`</${tag.name}>`)
      messageDepth -= 1
      if (messageDepth === 0 && localName(tag.name) === AIXM_MESSAGE_LOCAL_NAME) {
        completedMessages.push(messageXmlParts.join(''))
        messageXmlParts = []
      }
    })

    saxParser.on('error', (err: Error) => {
      errorRef.err = err
    })

    const flushBatch = async (): Promise<void> => {
      if (pendingNotams.length === 0) return
      const chunk = pendingNotams.splice(0)
      const { inserted, updated } = await this.notamModel.createBatch(chunk)
      notamsIngestedTotal.inc({ icao_location: 'all', source_format: 'aixm' }, inserted + updated)
      stats.upserted += inserted + updated
    }

    const drainCompletedMessages = async (): Promise<void> => {
      // Process in place; completedMessages is cleared at the end so new messages
      // accumulated while we awaited flushBatch() aren't lost.
      const batch = completedMessages.splice(0)
      for (const block of batch) {
        stats.totalMessages += 1
        const notam = this.parser.parseAIXMMessage(block)
        if (!notam) {
          stats.parseFailures += 1
          continue
        }
        pendingNotams.push(notam)
        stats.parsed += 1
        if (pendingNotams.length >= INITIAL_LOAD_BATCH_SIZE) {
          await flushBatch()
        }
      }
    }

    const nodeStream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
    const xmlStream = nodeStream.pipe(createGunzip())
    xmlStream.setEncoding('utf-8')

    for await (const chunk of xmlStream) {
      saxParser.write(chunk as string)
      if (errorRef.err) throw errorRef.err
      await drainCompletedMessages()
    }

    saxParser.close()
    if (errorRef.err) throw errorRef.err
    await drainCompletedMessages()
    await flushBatch()

    // Report the total messages seen for observability (mirrors the delta path).
    ingestionMessagesReceivedTotal.inc({ source: 'nms' }, stats.totalMessages)

    return stats
  }

  private scheduleNextPoll(): void {
    if (!this.isRunning) return
    // If an immediate retry is already queued (e.g. after a 401), don't also schedule
    // a normal-interval poll — that would cause duplicate poll cycles.
    if (this.immediateRetryTimer) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => void this.poll(), this.pollIntervalMs)
  }

  stop(): void {
    if (!this.isRunning) {
      logger.warn('Ingestion service not running')
      return
    }

    logger.info('Stopping NMS ingestion service')

    this.isRunning = false

    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }

    if (this.immediateRetryTimer) {
      clearTimeout(this.immediateRetryTimer)
      this.immediateRetryTimer = null
    }
    this.immediateRetryPending = false

    ingestionConnectionStatus.set({ source: 'nms' }, 0)
    logger.info('NMS ingestion service stopped')
  }

  isServiceRunning(): boolean {
    return this.isRunning
  }
}
