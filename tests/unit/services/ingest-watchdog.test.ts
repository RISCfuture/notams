import { startIngestWatchdog } from '../../../src/services/ingest-watchdog'

describe('startIngestWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not fire while polls keep succeeding within the threshold', () => {
    const onStale = vi.fn()
    let last = new Date()
    const stop = startIngestWatchdog(() => last, {
      staleThresholdMs: 5000,
      checkIntervalMs: 1000,
      onStale,
    })

    for (let i = 0; i < 6; i++) {
      last = new Date() // a fresh success each interval
      vi.advanceTimersByTime(1000)
    }

    expect(onStale).not.toHaveBeenCalled()
    stop()
  })

  it('fires exactly once after the threshold is exceeded with no success', () => {
    const onStale = vi.fn()
    const stop = startIngestWatchdog(() => null, {
      staleThresholdMs: 5000,
      checkIntervalMs: 1000,
      onStale,
    })

    vi.advanceTimersByTime(6000) // past threshold
    expect(onStale).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(10000) // would re-fire if not guarded
    expect(onStale).toHaveBeenCalledTimes(1)
    stop()
  })
})
