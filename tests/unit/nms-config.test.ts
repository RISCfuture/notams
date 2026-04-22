import { getNMSConfig, NMSTokenProvider } from '../../src/config/nms'

describe('NMS Config', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    // Restore original env vars
    process.env = { ...originalEnv }
  })

  describe('getNMSConfig', () => {
    it('should throw when NMS_CLIENT_ID is missing', () => {
      delete process.env.NMS_CLIENT_ID
      delete process.env.NMS_CLIENT_SECRET

      expect(() => getNMSConfig()).toThrow('NMS credentials not configured')
    })

    it('should return config when env vars are set', () => {
      process.env.NMS_CLIENT_ID = 'test-client-id'
      process.env.NMS_CLIENT_SECRET = 'test-client-secret'
      process.env.NMS_BASE_URL = 'https://test.example.com'
      process.env.NMS_POLL_INTERVAL_MS = '60000'

      const config = getNMSConfig()

      expect(config.clientId).toBe('test-client-id')
      expect(config.clientSecret).toBe('test-client-secret')
      expect(config.baseUrl).toBe('https://test.example.com')
      expect(config.pollIntervalMs).toBe(60000)
    })

    it('should use default baseUrl when NMS_BASE_URL is not set', () => {
      process.env.NMS_CLIENT_ID = 'test-id'
      process.env.NMS_CLIENT_SECRET = 'test-secret'
      delete process.env.NMS_BASE_URL

      const config = getNMSConfig()

      expect(config.baseUrl).toBe('https://api-staging.cgifederal-aim.com')
    })
  })

  describe('NMSTokenProvider', () => {
    const testConfig = {
      baseUrl: 'https://test.example.com',
      clientId: 'test-id',
      clientSecret: 'test-secret',
      pollIntervalMs: 60000,
    }

    const mockTokenResponse = {
      access_token: 'test-token-123',
      expires_in: '1799',
      token_type: 'BearerToken',
      status: 'approved',
    }

    const originalFetch = globalThis.fetch

    afterEach(() => {
      globalThis.fetch = originalFetch
      vi.restoreAllMocks()
    })

    it('should return access token on successful auth', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTokenResponse),
        }),
      )

      const provider = new NMSTokenProvider(testConfig)
      const token = await provider.getAccessToken()

      expect(token).toBe('test-token-123')
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledWith(
        'https://test.example.com/v1/auth/token',
        expect.objectContaining({
          method: 'POST',
          body: 'grant_type=client_credentials',
        }),
      )
    })

    it('should cache token and reuse on subsequent calls', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTokenResponse),
        }),
      )

      const provider = new NMSTokenProvider(testConfig)
      const token1 = await provider.getAccessToken()
      const token2 = await provider.getAccessToken()

      expect(token1).toBe('test-token-123')
      expect(token2).toBe('test-token-123')
      expect(fetch).toHaveBeenCalledOnce()
    })

    it('should refresh token when cache is expired', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTokenResponse),
        }),
      )

      const provider = new NMSTokenProvider(testConfig)
      await provider.getAccessToken()
      expect(fetch).toHaveBeenCalledOnce()

      // Clear cache to simulate expiry
      provider.resetCache()

      await provider.getAccessToken()
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('should retry on 5xx response', async () => {
      vi.useFakeTimers()

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Internal Server Error'),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTokenResponse),
        })

      vi.stubGlobal('fetch', mockFetch)

      const provider = new NMSTokenProvider(testConfig)
      const tokenPromise = provider.getAccessToken()

      // Advance past the 2s retry delay
      await vi.advanceTimersByTimeAsync(2000)

      const token = await tokenPromise

      expect(token).toBe('test-token-123')
      expect(mockFetch).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
    })

    it('should not retry on 4xx response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: () => Promise.resolve('Unauthorized'),
        }),
      )

      const provider = new NMSTokenProvider(testConfig)
      await expect(provider.getAccessToken()).rejects.toThrow('NMS auth failed (401)')
      expect(fetch).toHaveBeenCalledOnce()
    })

    it('should retry on network error (TypeError)', async () => {
      vi.useFakeTimers()

      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTokenResponse),
        })

      vi.stubGlobal('fetch', mockFetch)

      const provider = new NMSTokenProvider(testConfig)
      const tokenPromise = provider.getAccessToken()

      // Advance past the 2s retry delay
      await vi.advanceTimersByTimeAsync(2000)

      const token = await tokenPromise

      expect(token).toBe('test-token-123')
      expect(mockFetch).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
    })

    it('should throw after exhausting all retries', { timeout: 15000 }, async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Service Unavailable'),
      })

      vi.stubGlobal('fetch', mockFetch)

      const provider = new NMSTokenProvider(testConfig)
      // Use real timers with a generous test timeout — the delays are 2s + 4s = 6s
      // (only 2 retries have delays; the 3rd attempt fails and throws immediately)
      await expect(provider.getAccessToken()).rejects.toThrow('NMS auth failed (503)')
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })
  })
})
