import * as Sentry from '@sentry/node'
import { INGEST_MONITOR_SLUG, reportIngestHeartbeat } from '../../../src/config/ingest-monitor'

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof Sentry>()
  return { ...actual, captureCheckIn: vi.fn().mockReturnValue('id') }
})

describe('reportIngestHeartbeat', () => {
  const originalDsn = process.env.SENTRY_DSN

  afterEach(() => {
    if (originalDsn === undefined) delete process.env.SENTRY_DSN
    else process.env.SENTRY_DSN = originalDsn
    vi.restoreAllMocks()
  })

  it('is a no-op when SENTRY_DSN is unset', () => {
    delete process.env.SENTRY_DSN
    const spy = vi.mocked(Sentry.captureCheckIn)
    spy.mockClear()

    reportIngestHeartbeat(300000)

    expect(spy).not.toHaveBeenCalled()
  })

  it('sends an ok check-in with an interval schedule when SENTRY_DSN is set', () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0'
    const spy = vi.mocked(Sentry.captureCheckIn)
    spy.mockClear()

    reportIngestHeartbeat(300000) // 5-minute poll interval

    expect(spy).toHaveBeenCalledTimes(1)
    const [checkIn, monitorConfig] = spy.mock.calls[0]
    expect(checkIn).toEqual({ monitorSlug: INGEST_MONITOR_SLUG, status: 'ok' })
    expect(monitorConfig?.schedule).toEqual({ type: 'interval', value: 5, unit: 'minute' })
    expect(monitorConfig?.checkinMargin).toBe(5)
    expect(monitorConfig?.maxRuntime).toBeUndefined()
  })
})
