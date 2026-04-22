import { IngestionStateModel } from '../../../src/models/ingestion-state'

describe('IngestionStateModel', () => {
  let model: IngestionStateModel

  beforeEach(() => {
    model = new IngestionStateModel()
  })

  it('should return null when no last poll time is stored', async () => {
    const value = await model.getLastPollTime()
    expect(value).toBeNull()
  })

  it('should set and get the last poll time as a Date', async () => {
    const time = new Date('2026-04-21T12:34:56.000Z')
    await model.setLastPollTime(time)

    const stored = await model.getLastPollTime()
    expect(stored).toBeInstanceOf(Date)
    expect(stored?.toISOString()).toBe(time.toISOString())
  })

  it('should update an existing last poll time via upsert', async () => {
    const first = new Date('2026-04-20T00:00:00.000Z')
    const second = new Date('2026-04-21T00:00:00.000Z')

    await model.setLastPollTime(first)
    const afterFirst = await model.getLastPollTime()
    expect(afterFirst?.toISOString()).toBe(first.toISOString())

    await model.setLastPollTime(second)
    const afterSecond = await model.getLastPollTime()
    expect(afterSecond?.toISOString()).toBe(second.toISOString())
  })
})
