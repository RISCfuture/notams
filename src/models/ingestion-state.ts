import { pool } from '../config/database'
import { withRetry } from '../utils/retry'

const LAST_POLL_TIME_KEY = 'last_poll_time'

export class IngestionStateModel {
  async getLastPollTime(): Promise<Date | null> {
    const stored = await this.get(LAST_POLL_TIME_KEY)
    return stored === null ? null : new Date(stored)
  }

  async setLastPollTime(time: Date): Promise<void> {
    await this.set(LAST_POLL_TIME_KEY, time.toISOString())
  }

  private async get(key: string): Promise<string | null> {
    const result = await withRetry(async () => {
      return await pool.query('SELECT value FROM ingestion_state WHERE key = $1', [key])
    })
    return (result.rows[0] as { value: string } | undefined)?.value ?? null
  }

  private async set(key: string, value: string): Promise<void> {
    await withRetry(async () => {
      await pool.query(
        `INSERT INTO ingestion_state (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value],
      )
    })
  }
}
