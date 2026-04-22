import { pool } from '../config/database'
import { logger } from '../config/logger'
import { withRetry } from '../utils/retry'
import { dbQueryDuration, notamDuplicatesTotal } from '../config/metrics'

export interface NOTAM {
  id?: number
  notam_id: string
  icao_location: string
  effective_start: Date
  effective_end: Date | null
  schedule: string | null
  notam_text: string
  q_line: QLine | null
  purpose: string | null
  scope: string | null
  traffic_type: string | null
  raw_message: string | null
  created_at?: Date
  updated_at?: Date
}

export interface QLine {
  purpose?: string
  scope?: string
  traffic_type?: string
  lower_altitude?: string
  upper_altitude?: string
  coordinates?: string
}

export interface NOTAMQueryFilters {
  location?: string
  start?: Date
  end?: Date
  purpose?: string
  scope?: string
  limit?: number
  offset?: number
}

interface WhereClause {
  clause: string
  values: (string | Date | number)[]
  nextParam: number
}

function buildWhereClause(filters: NOTAMQueryFilters | undefined): WhereClause {
  const conditions: string[] = []
  const values: (string | Date | number)[] = []
  let paramIndex = 1

  if (filters?.location) {
    conditions.push(`icao_location = $${paramIndex++}`)
    values.push(filters.location)
  }

  if (filters?.start) {
    conditions.push(`(effective_end IS NULL OR effective_end >= $${paramIndex++})`)
    values.push(filters.start)
  }

  if (filters?.end) {
    conditions.push(`effective_start <= $${paramIndex++}`)
    values.push(filters.end)
  }

  if (filters?.purpose) {
    conditions.push(`purpose = $${paramIndex++}`)
    values.push(filters.purpose)
  }

  if (filters?.scope) {
    conditions.push(`scope = $${paramIndex++}`)
    values.push(filters.scope)
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
    nextParam: paramIndex,
  }
}

async function withQueryMetrics<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const startTime = process.hrtime.bigint()
  let success = 'true'

  try {
    return await fn()
  } catch (error) {
    success = 'false'
    throw error
  } finally {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9
    dbQueryDuration.observe({ operation, success }, duration)
  }
}

const BATCH_CHUNK_SIZE = 500
const PARAMS_PER_NOTAM = 11

export class NOTAMModel {
  async createBatch(notams: NOTAM[]): Promise<{ inserted: number; updated: number }> {
    if (notams.length === 0) {
      return { inserted: 0, updated: 0 }
    }

    let totalInserted = 0
    let totalUpdated = 0

    // Process in chunks to stay under PostgreSQL's 65535 parameter limit
    for (let i = 0; i < notams.length; i += BATCH_CHUNK_SIZE) {
      // Dedupe within the chunk on notam_id. Postgres' ON CONFLICT DO UPDATE
      // rejects the whole batch (21000 CARDINALITY_VIOLATION, ExecOnConflictUpdate)
      // when a single command proposes two rows with the same conflict key —
      // which happens on the initial load because unparseable NOTAMs all collapse
      // to notam_id='UNKNOWN', and the same AIXM NOTAM can appear multiple times
      // across revisions. Last occurrence wins so later revisions supersede earlier ones.
      const rawChunk = notams.slice(i, i + BATCH_CHUNK_SIZE)
      const deduped = new Map<string, NOTAM>()
      for (const notam of rawChunk) deduped.set(notam.notam_id, notam)
      const chunk = Array.from(deduped.values())
      const chunkIndex = Math.floor(i / BATCH_CHUNK_SIZE) + 1
      const totalChunks = Math.ceil(notams.length / BATCH_CHUNK_SIZE)

      const { inserted, updated } = await withQueryMetrics('upsert_batch', async () => {
        try {
          const valueTuples: string[] = []
          const queryParams: unknown[] = []

          for (let j = 0; j < chunk.length; j++) {
            const notam = chunk[j]
            const offset = j * PARAMS_PER_NOTAM
            const indices = Array.from({ length: PARAMS_PER_NOTAM }, (_, k) => `$${offset + k + 1}`)
            valueTuples.push(`(${indices.join(', ')})`)

            queryParams.push(
              notam.notam_id,
              notam.icao_location,
              notam.effective_start,
              notam.effective_end,
              notam.schedule,
              notam.notam_text,
              notam.q_line ? JSON.stringify(notam.q_line) : null,
              notam.purpose,
              notam.scope,
              notam.traffic_type,
              notam.raw_message,
            )
          }

          const query = `
            WITH upserted AS (
              INSERT INTO notams (
                notam_id, icao_location, effective_start, effective_end,
                schedule, notam_text, q_line, purpose, scope, traffic_type, raw_message
              )
              VALUES ${valueTuples.join(', ')}
              ON CONFLICT (notam_id)
              DO UPDATE SET
                icao_location = EXCLUDED.icao_location,
                effective_start = EXCLUDED.effective_start,
                effective_end = EXCLUDED.effective_end,
                schedule = EXCLUDED.schedule,
                notam_text = EXCLUDED.notam_text,
                q_line = EXCLUDED.q_line,
                purpose = EXCLUDED.purpose,
                scope = EXCLUDED.scope,
                traffic_type = EXCLUDED.traffic_type,
                raw_message = EXCLUDED.raw_message,
                updated_at = NOW()
              RETURNING (xmax = 0) AS is_new
            )
            SELECT
              COUNT(*) FILTER (WHERE is_new) AS inserted,
              COUNT(*) FILTER (WHERE NOT is_new) AS updated
            FROM upserted
          `

          const result = await withRetry(async () => {
            return await pool.query(query, queryParams)
          })

          const countsRow = result.rows[0] as {
            inserted: string | number
            updated: string | number
          }
          const chunkInserted = Number(countsRow.inserted)
          const chunkUpdated = Number(countsRow.updated)

          notamDuplicatesTotal.inc(chunkUpdated)

          logger.info(
            {
              chunk: chunkIndex,
              totalChunks,
              chunkSize: chunk.length,
              chunkInserted,
              chunkUpdated,
            },
            'Batch upsert chunk completed',
          )

          return { inserted: chunkInserted, updated: chunkUpdated }
        } catch (error) {
          logger.error(
            { error, chunk: chunkIndex, totalChunks, chunkSize: chunk.length },
            'Failed to batch upsert NOTAMs',
          )
          throw error
        }
      })

      totalInserted += inserted
      totalUpdated += updated
    }

    logger.info(
      { total: notams.length, inserted: totalInserted, updated: totalUpdated },
      'Batch upsert completed',
    )

    return { inserted: totalInserted, updated: totalUpdated }
  }

  async create(notam: NOTAM): Promise<NOTAM> {
    const query = `
      INSERT INTO notams (
        notam_id, icao_location, effective_start, effective_end,
        schedule, notam_text, q_line, purpose, scope, traffic_type, raw_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (notam_id)
      DO UPDATE SET
        icao_location = EXCLUDED.icao_location,
        effective_start = EXCLUDED.effective_start,
        effective_end = EXCLUDED.effective_end,
        schedule = EXCLUDED.schedule,
        notam_text = EXCLUDED.notam_text,
        q_line = EXCLUDED.q_line,
        purpose = EXCLUDED.purpose,
        scope = EXCLUDED.scope,
        traffic_type = EXCLUDED.traffic_type,
        raw_message = EXCLUDED.raw_message,
        updated_at = NOW()
      RETURNING *, (xmax = 0) AS inserted
    `

    const queryParams = [
      notam.notam_id,
      notam.icao_location,
      notam.effective_start,
      notam.effective_end,
      notam.schedule,
      notam.notam_text,
      notam.q_line ? JSON.stringify(notam.q_line) : null,
      notam.purpose,
      notam.scope,
      notam.traffic_type,
      notam.raw_message,
    ]

    return withQueryMetrics('upsert', async () => {
      try {
        const result = await withRetry(async () => {
          return await pool.query(query, queryParams)
        })

        const row = result.rows[0] as NOTAM & { inserted: boolean }

        // Track duplicate (upsert) vs insert
        if (!row.inserted) {
          notamDuplicatesTotal.inc()
        }

        logger.info({ notam_id: notam.notam_id }, 'NOTAM created/updated')
        return row
      } catch (error) {
        logger.error({ error, notam_id: notam.notam_id }, 'Failed to create/update NOTAM')
        throw error
      }
    })
  }

  async findById(notam_id: string): Promise<NOTAM | null> {
    const query = 'SELECT * FROM notams WHERE notam_id = $1'

    return withQueryMetrics('select', async () => {
      try {
        const result = await pool.query(query, [notam_id])
        return (result.rows[0] as NOTAM | undefined) ?? null
      } catch (error) {
        logger.error({ error, notam_id }, 'Failed to find NOTAM by ID')
        throw error
      }
    })
  }

  async findByFilters(filters: NOTAMQueryFilters): Promise<NOTAM[]> {
    const where = buildWhereClause(filters)
    const limit = filters.limit ?? 100
    const offset = filters.offset ?? 0

    const query = `
      SELECT * FROM notams
      ${where.clause}
      ORDER BY effective_start DESC
      LIMIT $${where.nextParam} OFFSET $${where.nextParam + 1}
    `

    const values = [...where.values, limit, offset]

    return withQueryMetrics('select', async () => {
      try {
        const result = await pool.query(query, values)
        logger.debug({ count: result.rows.length, filters }, 'NOTAMs retrieved')
        return result.rows as NOTAM[]
      } catch (error) {
        logger.error({ error, filters }, 'Failed to query NOTAMs')
        throw error
      }
    })
  }

  async deleteExpired(olderThanDays = 30): Promise<number> {
    const query = `
      DELETE FROM notams
      WHERE effective_end IS NOT NULL
        AND effective_end < NOW() - INTERVAL '1 day' * $1
    `

    return withQueryMetrics('delete', async () => {
      try {
        const result = await pool.query(query, [olderThanDays])
        logger.info({ count: result.rowCount, olderThanDays }, 'Expired NOTAMs deleted')
        return result.rowCount ?? 0
      } catch (error) {
        logger.error({ error }, 'Failed to delete expired NOTAMs')
        throw error
      }
    })
  }

  async count(filters?: NOTAMQueryFilters): Promise<number> {
    const where = buildWhereClause(filters)
    const query = `SELECT COUNT(*) FROM notams ${where.clause}`

    return withQueryMetrics('count', async () => {
      try {
        const result = await pool.query(query, where.values)
        const row = result.rows[0] as { count: string }
        return parseInt(row.count, 10)
      } catch (error) {
        logger.error({ error }, 'Failed to count NOTAMs')
        throw error
      }
    })
  }
}
