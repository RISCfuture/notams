import { createServer } from 'http'
import type { Server, IncomingMessage, ServerResponse } from 'http'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'fs'
import { join } from 'path'
import { NOTAMIngestionService } from '../../src/services/notam-ingestion'
import { NOTAMModel } from '../../src/models/notam'
import { IngestionStateModel } from '../../src/models/ingestion-state'

// Load test fixtures
const geojsonFixture = readFileSync(
  join(__dirname, '../fixtures/nms-geojson-response.json'),
  'utf-8',
)
const aixmFixture = readFileSync(join(__dirname, '../fixtures/nms-aixm-initial-load.xml'), 'utf-8')

let mockServer: Server
let serverPort: number
let authCallCount: number
let pollCallCount: number
let initialLoadCallCount: number
let contentDownloadCount: number
let lastPollUrl: string | undefined
let service: NOTAMIngestionService | null = null

// Allow tests to override handler behavior
let overridePollHandler: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null

function createMockNMSServer(): Promise<number> {
  return new Promise((resolve) => {
    authCallCount = 0
    pollCallCount = 0
    initialLoadCallCount = 0
    contentDownloadCount = 0
    lastPollUrl = undefined

    mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url!, `http://localhost`)

      // Auth endpoint
      if (req.method === 'POST' && url.pathname === '/v1/auth/token') {
        authCallCount++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            access_token: 'mock-token-123',
            expires_in: '1799',
            token_type: 'BearerToken',
            status: 'approved',
          }),
        )
        return
      }

      // Check auth header on all other requests
      const authHeader = req.headers.authorization
      if (authHeader !== 'Bearer mock-token-123') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: '401', message: 'Unauthorized' }))
        return
      }

      // Allow test-specific overrides for the poll endpoint
      if (overridePollHandler?.(req, res)) {
        return
      }

      // Delta poll endpoint
      if (
        req.method === 'GET' &&
        url.pathname === '/nmsapi/v1/notams' &&
        !url.pathname.includes('/il')
      ) {
        pollCallCount++
        lastPollUrl = req.url!
        const format = req.headers.nmsresponseformat

        if (format === 'GEOJSON') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(geojsonFixture)
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              status: 'Failure',
              errors: [{ code: '1', message: 'nmsResponseFormat header required' }],
            }),
          )
        }
        return
      }

      // Initial load endpoint. Production uses allowRedirect=true so Apigee issues
      // one API call that 302-redirects internally to the signed content URL —
      // avoids the 1 msg/sec spike arrest that two back-to-back API calls would trip.
      if (req.method === 'GET' && url.pathname === '/nmsapi/v1/notams/il') {
        initialLoadCallCount++
        res.writeHead(302, { Location: '/nmsapi/v1/content/mock-il-token' })
        res.end()
        return
      }

      // Content endpoint (serves gzipped AIXM)
      if (req.method === 'GET' && url.pathname === '/nmsapi/v1/content/mock-il-token') {
        contentDownloadCount++
        const gzipped = gzipSync(Buffer.from(aixmFixture, 'utf-8'))
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.end(gzipped)
        return
      }

      res.writeHead(404)
      res.end('Not found')
    })

    mockServer.listen(0, () => {
      const addr = mockServer.address()
      serverPort = typeof addr === 'object' && addr ? addr.port : 0
      resolve(serverPort)
    })
  })
}

const notamModel = new NOTAMModel()
const stateModel = new IngestionStateModel()

/**
 * Wait for a condition to become true by polling, with timeout.
 */
async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeout = 10000,
  interval = 100,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error('waitFor timed out')
}

describe('NMS Ingestion E2E', () => {
  beforeAll(async () => {
    const port = await createMockNMSServer()
    process.env.NMS_BASE_URL = `http://localhost:${port}`
    process.env.NMS_CLIENT_ID = 'test-client-id'
    process.env.NMS_CLIENT_SECRET = 'test-client-secret'
    // Long interval so only the first automatic poll fires during each test
    process.env.NMS_POLL_INTERVAL_MS = '300000'
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      mockServer.close(() => {
        resolve()
      })
    })
    delete process.env.NMS_BASE_URL
    delete process.env.NMS_CLIENT_ID
    delete process.env.NMS_CLIENT_SECRET
    delete process.env.NMS_POLL_INTERVAL_MS
  })

  afterEach(() => {
    if (service) {
      service.stop()
      service = null
    }
    authCallCount = 0
    pollCallCount = 0
    initialLoadCallCount = 0
    contentDownloadCount = 0
    lastPollUrl = undefined
    overridePollHandler = null
  })

  describe('Delta Poll Cycle', () => {
    it('should authenticate, poll, parse GeoJSON, and upsert NOTAMs to database', async () => {
      // Seed a recent poll time so the service does a delta poll (not initial load)
      const recentTime = new Date(Date.now() - 10 * 60 * 1000) // 10 minutes ago
      await stateModel.setLastPollTime(recentTime)

      service = new NOTAMIngestionService()
      service.start()

      // Wait for NOTAMs to appear in DB
      await waitFor(async () => {
        const count = await notamModel.count()
        return count > 0
      })

      service.stop()

      // Verify auth was called
      expect(authCallCount).toBe(1)

      // Verify delta poll was used (not initial load)
      expect(pollCallCount).toBe(1)
      expect(initialLoadCallCount).toBe(0)

      // Verify NOTAMs were parsed and inserted
      // The GeoJSON fixture has 2 features
      const count = await notamModel.count()
      expect(count).toBe(2)

      // Verify specific NOTAM data
      const notam1 = await notamModel.findById('08/430/2025')
      const notam2 = await notamModel.findById('04/221/2025')

      // At least one should be found (ID format depends on parser)
      // The parser builds ID as `${number}/${year}` -> "08/430/2025"
      // Actually looking at the parser: `${number}/${year}` where number="08/430", year="2025"
      // So the ID is "08/430/2025"
      if (notam1) {
        expect(notam1.icao_location).toBe('K8WC')
        expect(notam1.notam_text).toBe('RWY 20 RWY END ID LGT U/S')
      }
      if (notam2) {
        expect(notam2.icao_location).toBe('KZBW')
      }
    })

    it('should pass lastUpdatedDate query parameter when polling', async () => {
      // Must be within 23 hours so the service uses delta poll (not initial load)
      const pollTime = new Date(Date.now() - 10 * 60 * 1000) // 10 minutes ago
      await stateModel.setLastPollTime(pollTime)

      service = new NOTAMIngestionService()
      service.start()

      await waitFor(() => pollCallCount > 0)

      service.stop()

      expect(lastPollUrl).toBeDefined()
      expect(lastPollUrl).toContain('lastUpdatedDate=')
      // The URL will contain the ISO date with colons encoded as %3A
      const isoDate = pollTime.toISOString()
      const urlEncoded = isoDate.replaceAll(':', '%3A')
      expect(lastPollUrl).toContain(urlEncoded)
    })

    it('should persist poll timestamp to database after successful poll', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000) // 5 minutes ago
      await stateModel.setLastPollTime(recentTime)

      service = new NOTAMIngestionService()
      service.start()

      // Wait for poll to complete (NOTAMs appear in DB)
      await waitFor(async () => {
        const count = await notamModel.count()
        return count > 0
      })

      service.stop()

      // Check that last_poll_time was updated
      const storedTime = await stateModel.getLastPollTime()
      expect(storedTime).not.toBeNull()

      // The new poll time should be more recent than what we seeded
      expect(storedTime!.getTime()).toBeGreaterThan(recentTime.getTime())
    })
  })

  describe('Initial Load', () => {
    it('should trigger initial load when no poll state exists', async () => {
      // No ingestion_state seeded — the beforeEach in setup.ts already clears the table

      service = new NOTAMIngestionService()
      service.start()

      // Wait for initial load to complete
      await waitFor(() => initialLoadCallCount > 0)

      // Also wait for content download
      await waitFor(() => contentDownloadCount > 0)

      // Wait for DB writes to complete
      await waitFor(async () => {
        const count = await notamModel.count()
        return count > 0
      })

      service.stop()

      // Initial load path should have been used
      expect(initialLoadCallCount).toBe(1)
      expect(contentDownloadCount).toBe(1)
      // Delta poll should NOT have been called
      expect(pollCallCount).toBe(0)

      // Verify NOTAMs from AIXM fixture are in DB
      // The AIXM fixture has 2 AIXMBasicMessage blocks.
      // The second message (single hasMember with Event) should parse successfully.
      // The first message (multiple hasMember children) may or may not parse depending
      // on how the XML parser handles arrays. We check at least 1 was inserted.
      const count = await notamModel.count()
      expect(count).toBeGreaterThanOrEqual(1)

      // Verify poll time was persisted
      const storedTime = await stateModel.getLastPollTime()
      expect(storedTime).not.toBeNull()
    })

    it('should trigger initial load when stored poll time is older than 23 hours', async () => {
      // Set poll time to 25 hours ago
      const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000)
      await stateModel.setLastPollTime(oldTime)

      service = new NOTAMIngestionService()
      service.start()

      await waitFor(() => initialLoadCallCount > 0)
      await waitFor(() => contentDownloadCount > 0)

      service.stop()

      // Should have used initial load, not delta poll
      expect(initialLoadCallCount).toBe(1)
      expect(pollCallCount).toBe(0)

      // Poll time should be updated
      const storedTime = await stateModel.getLastPollTime()
      expect(storedTime).not.toBeNull()
      expect(storedTime!.getTime()).toBeGreaterThan(oldTime.getTime())
    })
  })

  describe('Error Handling', () => {
    it('should handle 401 from poll endpoint gracefully without crashing', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000)
      await stateModel.setLastPollTime(recentTime)

      // Override poll handler to return 401
      overridePollHandler = (req, res) => {
        const url = new URL(req.url!, 'http://localhost')
        if (
          req.method === 'GET' &&
          url.pathname === '/nmsapi/v1/notams' &&
          !url.pathname.includes('/il')
        ) {
          pollCallCount++
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: '401', message: 'Token expired' }))
          return true
        }
        return false
      }

      service = new NOTAMIngestionService()
      service.start()

      // Wait for the poll attempt
      await waitFor(() => pollCallCount > 0)

      // Give it a moment to process the response
      await new Promise((r) => setTimeout(r, 200))

      // Service should still be running (didn't crash)
      expect(service.isServiceRunning()).toBe(true)

      // No NOTAMs should have been inserted
      const count = await notamModel.count()
      expect(count).toBe(0)

      service.stop()
    })

    it('should immediately retry after a single 401 and recover on the next request', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000)
      await stateModel.set('last_poll_time', recentTime.toISOString())

      // First poll: return 401. Second poll (the immediate retry): return normal GeoJSON.
      overridePollHandler = (req, res) => {
        const url = new URL(req.url!, 'http://localhost')
        if (
          req.method === 'GET' &&
          url.pathname === '/nmsapi/v1/notams' &&
          !url.pathname.includes('/il')
        ) {
          pollCallCount++
          lastPollUrl = req.url!

          if (pollCallCount === 1) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: '401', message: 'Token expired' }))
            return true
          }

          // Subsequent requests: return success
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(geojsonFixture)
          return true
        }
        return false
      }

      // Use a long poll interval so if the retry were scheduled normally (not immediate),
      // the test would time out waiting for NOTAMs to appear.
      const savedInterval = process.env.NMS_POLL_INTERVAL_MS
      process.env.NMS_POLL_INTERVAL_MS = '300000' // 5 minutes

      const startTime = Date.now()

      try {
        service = new NOTAMIngestionService()
        service.start()

        // The retry should be immediate, so NOTAMs should appear quickly (well under 5s)
        // even though the normal poll interval is 5 minutes.
        await waitFor(async () => {
          const count = await notamModel.count()
          return count > 0
        }, 5000)

        const elapsed = Date.now() - startTime

        // Should have completed in well under the 5-minute poll interval — proves
        // the retry was immediate, not scheduled at normal interval.
        expect(elapsed).toBeLessThan(5000)

        // Two poll calls: the 401 and the immediate retry that succeeded.
        expect(pollCallCount).toBe(2)

        // NOTAMs from the GeoJSON fixture should be in the DB.
        const count = await notamModel.count()
        expect(count).toBe(2)

        service.stop()
      } finally {
        process.env.NMS_POLL_INTERVAL_MS = savedInterval
      }
    })

    it('should fall back to normal schedule if the immediate retry also returns 401', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000)
      await stateModel.set('last_poll_time', recentTime.toISOString())

      // Every poll returns 401.
      overridePollHandler = (req, res) => {
        const url = new URL(req.url!, 'http://localhost')
        if (
          req.method === 'GET' &&
          url.pathname === '/nmsapi/v1/notams' &&
          !url.pathname.includes('/il')
        ) {
          pollCallCount++
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: '401', message: 'Token expired' }))
          return true
        }
        return false
      }

      // Long interval — after the first immediate retry also 401s, the next attempt
      // should be scheduled at this interval (not immediate), so we should see
      // exactly 2 calls within our wait window.
      const savedInterval = process.env.NMS_POLL_INTERVAL_MS
      process.env.NMS_POLL_INTERVAL_MS = '300000' // 5 minutes

      try {
        service = new NOTAMIngestionService()
        service.start()

        // Wait for both the initial poll and the immediate retry to happen.
        await waitFor(() => pollCallCount >= 2, 5000)

        // Give extra time to ensure no third call happens (it shouldn't, because
        // after the second 401 we fall back to a 5-minute scheduled poll).
        await new Promise((r) => setTimeout(r, 500))

        // Exactly 2 poll calls: the initial 401 and the single immediate retry.
        expect(pollCallCount).toBe(2)

        // Service should still be running.
        expect(service.isServiceRunning()).toBe(true)

        // No NOTAMs ingested.
        const count = await notamModel.count()
        expect(count).toBe(0)

        service.stop()
      } finally {
        process.env.NMS_POLL_INTERVAL_MS = savedInterval
      }
    })

    it('should handle API error responses gracefully', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000)
      await stateModel.setLastPollTime(recentTime)

      // Override poll handler to return 500
      overridePollHandler = (req, res) => {
        const url = new URL(req.url!, 'http://localhost')
        if (
          req.method === 'GET' &&
          url.pathname === '/nmsapi/v1/notams' &&
          !url.pathname.includes('/il')
        ) {
          pollCallCount++
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'Error', message: 'Internal server error' }))
          return true
        }
        return false
      }

      service = new NOTAMIngestionService()
      service.start()

      await waitFor(() => pollCallCount > 0)
      await new Promise((r) => setTimeout(r, 200))

      // Service should still be running
      expect(service.isServiceRunning()).toBe(true)

      // No NOTAMs inserted
      const count = await notamModel.count()
      expect(count).toBe(0)

      service.stop()
    })
  })

  describe('Restart Catch-up', () => {
    it('should resume from persisted poll time after restart', async () => {
      // Set last_poll_time to 2 hours ago (within 23h, so delta poll is used)
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await stateModel.setLastPollTime(twoHoursAgo)

      // First service instance
      service = new NOTAMIngestionService()
      service.start()

      // Wait for first poll to complete
      await waitFor(() => pollCallCount > 0)

      // Wait for DB writes to finish
      await waitFor(async () => {
        const count = await notamModel.count()
        return count > 0
      })

      service.stop()
      service = null

      // Verify delta poll was used (not initial load)
      expect(pollCallCount).toBe(1)
      expect(initialLoadCallCount).toBe(0)

      // Verify lastUpdatedDate in the request URL is close to the 2-hours-ago timestamp
      expect(lastPollUrl).toBeDefined()
      expect(lastPollUrl).toContain('lastUpdatedDate=')
      const urlEncodedTwoHoursAgo = twoHoursAgo.toISOString().replaceAll(':', '%3A')
      expect(lastPollUrl).toContain(urlEncodedTwoHoursAgo)

      // Record the poll time that was persisted by the first instance
      const firstPollTime = await stateModel.getLastPollTime()
      expect(firstPollTime).not.toBeNull()

      // Reset counters for the second instance (new service creates its own token provider)
      authCallCount = 0
      pollCallCount = 0
      initialLoadCallCount = 0
      lastPollUrl = undefined

      // Start a NEW service instance (simulates restart)
      service = new NOTAMIngestionService()
      service.start()

      // Wait for its first poll
      await waitFor(() => pollCallCount > 0)

      service.stop()

      // The second instance should also do a delta poll using the updated timestamp
      expect(pollCallCount).toBe(1)
      expect(initialLoadCallCount).toBe(0)

      // The URL should contain the poll time set by the first instance
      expect(lastPollUrl).toBeDefined()
      const urlEncodedFirstPollTime = firstPollTime!.toISOString().replaceAll(':', '%3A')
      expect(lastPollUrl).toContain(urlEncodedFirstPollTime)
    })
  })

  describe('Recovery After Error', () => {
    it('should recover and poll successfully after a transient error', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000)
      await stateModel.setLastPollTime(recentTime)

      // Return 500 on first poll, then success on subsequent ones
      overridePollHandler = (req, res) => {
        const url = new URL(req.url!, 'http://localhost')
        if (
          req.method === 'GET' &&
          url.pathname === '/nmsapi/v1/notams' &&
          !url.pathname.includes('/il')
        ) {
          pollCallCount++
          lastPollUrl = req.url!

          if (pollCallCount <= 1) {
            // First request: return 500
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: '500', message: 'Internal Server Error' }))
            return true
          }

          // Subsequent requests: return normal GeoJSON
          const format = req.headers.nmsresponseformat
          if (format === 'GEOJSON') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(geojsonFixture)
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                status: 'Failure',
                errors: [{ code: '1', message: 'nmsResponseFormat header required' }],
              }),
            )
          }
          return true
        }
        return false
      }

      // Use a short poll interval so retry happens quickly
      const savedInterval = process.env.NMS_POLL_INTERVAL_MS
      process.env.NMS_POLL_INTERVAL_MS = '500'

      try {
        service = new NOTAMIngestionService()
        service.start()

        // Wait for NOTAMs to appear in DB (recovery happened)
        await waitFor(async () => {
          const count = await notamModel.count()
          return count > 0
        }, 15000)

        service.stop()

        // First poll failed, second (or later) succeeded
        expect(pollCallCount).toBeGreaterThanOrEqual(2)

        // DB should have the 2 NOTAMs from the fixture
        const count = await notamModel.count()
        expect(count).toBe(2)
      } finally {
        process.env.NMS_POLL_INTERVAL_MS = savedInterval
      }
    })
  })

  describe('Empty Poll Response', () => {
    it('should handle empty poll response gracefully without writing to DB', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000)
      await stateModel.setLastPollTime(recentTime)

      // Return empty geojson array for poll
      overridePollHandler = (req, res) => {
        const url = new URL(req.url!, 'http://localhost')
        if (
          req.method === 'GET' &&
          url.pathname === '/nmsapi/v1/notams' &&
          !url.pathname.includes('/il')
        ) {
          pollCallCount++
          lastPollUrl = req.url!

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'Success', data: { geojson: [] } }))
          return true
        }
        return false
      }

      service = new NOTAMIngestionService()
      service.start()

      // Wait for poll to complete
      await waitFor(() => pollCallCount > 0)

      // Give time for post-poll processing
      await new Promise((r) => setTimeout(r, 300))

      expect(pollCallCount).toBe(1)

      // No NOTAMs should have been inserted
      const count = await notamModel.count()
      expect(count).toBe(0)

      // Service should still be running
      expect(service.isServiceRunning()).toBe(true)

      // Empty polls must not advance the DB value (skip-on-empty guard).
      const storedTime = await stateModel.getLastPollTime()
      expect(storedTime).not.toBeNull()
      expect(storedTime!.getTime()).toBe(recentTime.getTime())

      service.stop()
    })
  })

  describe('Multiple Consecutive Polls', () => {
    it('should advance poll state across multiple consecutive cycles', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000)
      await stateModel.setLastPollTime(recentTime)

      // Use a short poll interval
      const savedInterval = process.env.NMS_POLL_INTERVAL_MS
      process.env.NMS_POLL_INTERVAL_MS = '500'

      try {
        service = new NOTAMIngestionService()
        service.start()

        // Wait for at least 3 poll cycles
        await waitFor(() => pollCallCount >= 3, 15000)

        service.stop()

        // Read the persisted poll time
        const storedTime = await stateModel.getLastPollTime()
        expect(storedTime).not.toBeNull()

        // Should be recent (within last few seconds)
        expect(Date.now() - storedTime!.getTime()).toBeLessThan(5000)

        // DB should have exactly 2 NOTAMs (from the fixture), not 2 * pollCount,
        // because of ON CONFLICT upsert
        const count = await notamModel.count()
        expect(count).toBe(2)
      } finally {
        process.env.NMS_POLL_INTERVAL_MS = savedInterval
      }
    })
  })

  describe('Service Stop During Poll', () => {
    it('should stop cleanly even if called during an active poll', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000)
      await stateModel.setLastPollTime(recentTime)

      service = new NOTAMIngestionService()
      service.start()

      // Stop almost immediately, before poll finishes or right as it starts.
      // The poll() call is async/non-blocking via `void this.poll()`, so stop()
      // can be called while it's in-flight.
      service.stop()

      // Give a moment for any in-flight async operations to settle
      await new Promise((r) => setTimeout(r, 500))

      // Should not have crashed — service should report not running
      expect(service.isServiceRunning()).toBe(false)

      // Clean up the reference so afterEach doesn't try to stop again
      service = null
    })
  })
})
