import { logger } from './logger'
import { withRetry, isRetriableHttpError } from '../utils/retry'

export interface NMSConfig {
  baseUrl: string
  clientId: string
  clientSecret: string
  pollIntervalMs: number
}

export const getNMSConfig = (): NMSConfig => {
  const config: NMSConfig = {
    baseUrl: process.env.NMS_BASE_URL ?? 'https://api-staging.cgifederal-aim.com',
    clientId: process.env.NMS_CLIENT_ID ?? '',
    clientSecret: process.env.NMS_CLIENT_SECRET ?? '',
    pollIntervalMs: parseInt(process.env.NMS_POLL_INTERVAL_MS ?? '300000', 10),
  }

  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      'NMS credentials not configured. Set NMS_CLIENT_ID and NMS_CLIENT_SECRET environment variables.',
    )
  }

  return config
}

interface TokenState {
  accessToken: string
  expiresAt: number
}

/** Refresh bearer tokens this far before expiration to avoid mid-request expiry. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

/** 3 total attempts: initial + 2 retries with 2s, 4s backoff. */
const AUTH_MAX_RETRIES = 2
const AUTH_BACKOFF_BASE_MS = 2000
const AUTH_MAX_BACKOFF_MS = 8000

export class NMSTokenProvider {
  private cachedToken: TokenState | null = null

  constructor(private readonly config: NMSConfig) {}

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return this.cachedToken.accessToken
    }

    const authUrl = `${this.config.baseUrl}/v1/auth/token`
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64',
    )

    logger.info('Refreshing NMS bearer token')

    const data = await withRetry(
      async () => {
        const response = await fetch(authUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${credentials}`,
          },
          body: 'grant_type=client_credentials',
        })

        if (!response.ok) {
          const body = await response.text()
          const error = new Error(`NMS auth failed (${response.status}): ${body}`)
          if (response.status >= 500) {
            Object.assign(error, { retriable: true })
          }
          throw error
        }

        return (await response.json()) as { access_token: string; expires_in: string }
      },
      {
        maxRetries: AUTH_MAX_RETRIES,
        backoffBase: AUTH_BACKOFF_BASE_MS,
        maxBackoff: AUTH_MAX_BACKOFF_MS,
        isRetriable: isRetriableHttpError,
      },
    )

    const expiresInMs = parseInt(data.expires_in, 10) * 1000
    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + expiresInMs,
    }

    logger.info({ expiresInSeconds: data.expires_in }, 'NMS bearer token refreshed')
    return this.cachedToken.accessToken
  }

  resetCache(): void {
    this.cachedToken = null
  }
}
