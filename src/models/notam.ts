import { pool } from '../config/database';
import { logger } from '../config/logger';
import { withRetry } from '../utils/retry';
import { dbQueryDuration, notamDuplicatesTotal } from '../config/metrics';

export interface NOTAM {
  id?: number;
  notam_id: string;
  icao_location: string;
  effective_start: Date;
  effective_end: Date | null;
  schedule: string | null;
  notam_text: string;
  q_line: QLine | null;
  purpose: string | null;
  scope: string | null;
  traffic_type: string | null;
  raw_message: string | null;
  created_at?: Date;
  updated_at?: Date;
}

export interface QLine {
  purpose?: string;
  scope?: string;
  traffic_type?: string;
  lower_altitude?: string;
  upper_altitude?: string;
  coordinates?: string;
}

export interface NOTAMQueryFilters {
  location?: string;
  start?: Date;
  end?: Date;
  purpose?: string;
  scope?: string;
  limit?: number;
  offset?: number;
}

export class NOTAMModel {
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
    `;

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
    ];

    const startTime = process.hrtime.bigint();
    let success = 'true';

    try {
      const result = await withRetry(async () => {
        return await pool.query(query, queryParams);
      });

      // Track duplicate (upsert) vs insert
      if (!result.rows[0].inserted) {
        notamDuplicatesTotal.inc();
      }

      logger.info({ notam_id: notam.notam_id }, 'NOTAM created/updated');
      return result.rows[0];
    } catch (error) {
      success = 'false';
      logger.error({ error, notam_id: notam.notam_id }, 'Failed to create/update NOTAM');
      throw error;
    } finally {
      const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
      dbQueryDuration.observe({ operation: 'upsert', success }, duration);
    }
  }

  async findById(notam_id: string): Promise<NOTAM | null> {
    const query = 'SELECT * FROM notams WHERE notam_id = $1';
    const startTime = process.hrtime.bigint();
    let success = 'true';

    try {
      const result = await pool.query(query, [notam_id]);
      return result.rows[0] || null;
    } catch (error) {
      success = 'false';
      logger.error({ error, notam_id }, 'Failed to find NOTAM by ID');
      throw error;
    } finally {
      const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
      dbQueryDuration.observe({ operation: 'select', success }, duration);
    }
  }

  async findByFilters(filters: NOTAMQueryFilters): Promise<NOTAM[]> {
    const conditions: string[] = [];
    const values: (string | Date | number)[] = [];
    let paramIndex = 1;

    if (filters.location) {
      conditions.push(`icao_location = $${paramIndex++}`);
      values.push(filters.location);
    }

    if (filters.start) {
      conditions.push(`(effective_end IS NULL OR effective_end >= $${paramIndex++})`);
      values.push(filters.start);
    }

    if (filters.end) {
      conditions.push(`effective_start <= $${paramIndex++}`);
      values.push(filters.end);
    }

    if (filters.purpose) {
      conditions.push(`purpose = $${paramIndex++}`);
      values.push(filters.purpose);
    }

    if (filters.scope) {
      conditions.push(`scope = $${paramIndex++}`);
      values.push(filters.scope);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    const query = `
      SELECT * FROM notams
      ${whereClause}
      ORDER BY effective_start DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    values.push(limit, offset);

    const startTime = process.hrtime.bigint();
    let success = 'true';

    try {
      const result = await pool.query(query, values);
      logger.debug({ count: result.rows.length, filters }, 'NOTAMs retrieved');
      return result.rows;
    } catch (error) {
      success = 'false';
      logger.error({ error, filters }, 'Failed to query NOTAMs');
      throw error;
    } finally {
      const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
      dbQueryDuration.observe({ operation: 'select', success }, duration);
    }
  }

  async deleteExpired(olderThanDays: number = 30): Promise<number> {
    const query = `
      DELETE FROM notams
      WHERE effective_end IS NOT NULL
        AND effective_end < NOW() - INTERVAL '1 day' * $1
    `;

    const startTime = process.hrtime.bigint();
    let success = 'true';

    try {
      const result = await pool.query(query, [olderThanDays]);
      logger.info({ count: result.rowCount, olderThanDays }, 'Expired NOTAMs deleted');
      return result.rowCount || 0;
    } catch (error) {
      success = 'false';
      logger.error({ error }, 'Failed to delete expired NOTAMs');
      throw error;
    } finally {
      const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
      dbQueryDuration.observe({ operation: 'delete', success }, duration);
    }
  }

  async count(filters?: NOTAMQueryFilters): Promise<number> {
    const conditions: string[] = [];
    const values: (string | Date | number)[] = [];
    let paramIndex = 1;

    if (filters?.location) {
      conditions.push(`icao_location = $${paramIndex++}`);
      values.push(filters.location);
    }

    if (filters?.start) {
      conditions.push(`(effective_end IS NULL OR effective_end >= $${paramIndex++})`);
      values.push(filters.start);
    }

    if (filters?.end) {
      conditions.push(`effective_start <= $${paramIndex++}`);
      values.push(filters.end);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `SELECT COUNT(*) FROM notams ${whereClause}`;

    const startTime = process.hrtime.bigint();
    let success = 'true';

    try {
      const result = await pool.query(query, values);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      success = 'false';
      logger.error({ error }, 'Failed to count NOTAMs');
      throw error;
    } finally {
      const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
      dbQueryDuration.observe({ operation: 'count', success }, duration);
    }
  }
}
