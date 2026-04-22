import { withRetry, isRetriableHttpError } from '../utils/retry'

export type NMSStatus = 'Success' | 'Failure'

export interface NMSEnvelope<T> {
  status: NMSStatus
  errors?: { code: string; message: string }[]
  data: T
}

/** HTTP error thrown by {@link nmsRequest} so callers can react to specific status codes (e.g. 401). */
export class NMSHttpError extends Error {
  readonly status: number
  readonly body: string
  /** Set to true for errors the retry layer should retry (5xx). */
  readonly retriable: boolean

  constructor(status: number, body: string, retriable: boolean) {
    super(`NMS API error (${String(status)}): ${body}`)
    this.name = 'NMSHttpError'
    this.status = status
    this.body = body
    this.retriable = retriable
  }
}

interface NMSRequestOptionsBase {
  /** Extra headers merged with the Authorization header. */
  headers?: Record<string, string>
  /**
   * AbortSignal propagated to fetch. Covers the full lifecycle including body streaming,
   * so a stalled download (e.g. Apigee/GCS silently closes the transport) surfaces as an
   * AbortError instead of hanging the poll loop forever. Callers should supply
   * `AbortSignal.timeout(ms)` for streamed binary downloads.
   */
  signal?: AbortSignal
  maxRetries?: number
  backoffBase?: number
  maxBackoff?: number
}

interface NMSJsonRequestOptions extends NMSRequestOptionsBase {
  /** Parse the response as a JSON NMSEnvelope and verify `status === 'Success'` (default). */
  raw?: false
}

interface NMSRawRequestOptions extends NMSRequestOptionsBase {
  /** Skip envelope parsing — return the raw `Response` (for binary content like gzipped AIXM). */
  raw: true
}

/**
 * Perform an authenticated GET against the NMS API with retry semantics.
 *
 * Default mode parses a JSON `NMSEnvelope<T>` and throws on `status !== 'Success'`.
 * Raw mode returns the underlying `Response` so callers can stream / read bytes.
 *
 * 5xx responses throw a retriable {@link NMSHttpError} which `withRetry` will retry.
 * All other non-ok responses (including 401) throw a non-retriable `NMSHttpError`
 * which is propagated immediately so callers can react (e.g. reset token on 401).
 */
export function nmsRequest<T>(
  url: string,
  token: string,
  options?: NMSJsonRequestOptions,
): Promise<NMSEnvelope<T>>
export function nmsRequest(
  url: string,
  token: string,
  options: NMSRawRequestOptions,
): Promise<Response>
export async function nmsRequest<T>(
  url: string,
  token: string,
  options: NMSJsonRequestOptions | NMSRawRequestOptions = {},
): Promise<NMSEnvelope<T> | Response> {
  const { headers, signal, maxRetries, backoffBase, maxBackoff } = options
  const raw = options.raw === true

  return withRetry(
    async () => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, ...headers },
        signal,
      })

      if (!response.ok) {
        const body = await response.text()
        throw new NMSHttpError(response.status, body, response.status >= 500)
      }

      if (raw) return response

      const envelope = (await response.json()) as NMSEnvelope<T>
      if (envelope.status !== 'Success') {
        const errorMessages = envelope.errors?.map((e) => e.message).join('; ') ?? 'unknown'
        throw new Error(`NMS API returned failure: ${errorMessages}`)
      }
      return envelope
    },
    {
      maxRetries: maxRetries ?? parseInt(process.env.NMS_MAX_RETRIES ?? '2', 10),
      backoffBase: backoffBase ?? parseInt(process.env.NMS_RETRY_BACKOFF_BASE_MS ?? '1000', 10),
      maxBackoff: maxBackoff ?? parseInt(process.env.NMS_RETRY_MAX_BACKOFF_MS ?? '4000', 10),
      isRetriable: isRetriableHttpError,
    },
  )
}
