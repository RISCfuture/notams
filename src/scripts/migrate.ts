import dotenv from 'dotenv'
dotenv.config()

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Pool, PoolClient } from 'pg'
import { pool, closePool, testConnection } from '../config/database'
import { logger } from '../config/logger'

const MIGRATIONS_DIR = join(__dirname, '../../migrations')

const SCHEMA_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

// Migrations that create a known table. If the table already exists on a
// database that predates schema_migrations tracking, mark the migration as
// applied rather than re-running it. Includes 004 itself — its table is
// created via SCHEMA_MIGRATIONS_TABLE_SQL above, so this records it uniformly.
const KNOWN_MIGRATION_TABLES: readonly { filename: string; targetTable: string }[] = [
  { filename: '001_create_notams.sql', targetTable: 'notams' },
  { filename: '002_create_tokens.sql', targetTable: 'api_tokens' },
  { filename: '003_create_ingestion_state.sql', targetTable: 'ingestion_state' },
  { filename: '004_create_schema_migrations.sql', targetTable: 'schema_migrations' },
]

function listMigrationFiles(dir: string): string[] {
  const entries: string[] = readdirSync(dir, { encoding: 'utf-8' })
  const sqlFiles: string[] = entries.filter((name) => name.endsWith('.sql'))
  sqlFiles.sort()
  return sqlFiles
}

async function getAppliedMigrations(db: Pool | PoolClient): Promise<Set<string>> {
  const result = await db.query<{ filename: string }>('SELECT filename FROM schema_migrations')
  return new Set(result.rows.map((row) => row.filename))
}

async function tableExists(db: Pool | PoolClient, tableName: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_tables
       WHERE schemaname = current_schema() AND tablename = $1
     ) AS exists`,
    [tableName],
  )
  return result.rows[0]?.exists ?? false
}

async function markPreExistingTablesAsApplied(
  db: Pool | PoolClient,
  applied: Set<string>,
): Promise<void> {
  for (const { filename, targetTable } of KNOWN_MIGRATION_TABLES) {
    if (applied.has(filename)) continue
    if (await tableExists(db, targetTable)) {
      await db.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [filename],
      )
      applied.add(filename)
      logger.info({ migration: filename }, 'Marked pre-existing migration as applied')
    }
  }
}

async function applyMigration(db: Pool, filename: string, sql: string): Promise<void> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
      [filename],
    )
    await client.query('COMMIT')
  } catch (error) {
    // Swallow rollback errors so we re-throw the original, more useful error.
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function runPendingMigrations(db: Pool, migrationsDir: string): Promise<string[]> {
  await db.query(SCHEMA_MIGRATIONS_TABLE_SQL)

  const applied = await getAppliedMigrations(db)
  await markPreExistingTablesAsApplied(db, applied)

  const appliedNow: string[] = []
  for (const filename of listMigrationFiles(migrationsDir)) {
    if (applied.has(filename)) {
      logger.debug({ migration: filename }, 'Skipping already-applied migration')
      continue
    }

    logger.info({ migration: filename }, 'Applying migration')
    const sql = readFileSync(join(migrationsDir, filename), 'utf-8')
    await applyMigration(db, filename, sql)
    applied.add(filename)
    appliedNow.push(filename)
    logger.info({ migration: filename }, 'Migration applied')
  }

  return appliedNow
}

async function runMigrations(): Promise<void> {
  try {
    logger.info('Starting database migrations')

    const dbConnected = await testConnection()
    if (!dbConnected) {
      logger.error('Failed to connect to database')
      process.exit(1)
    }

    const appliedNow = await runPendingMigrations(pool, MIGRATIONS_DIR)

    if (appliedNow.length === 0) {
      logger.info('Database is up to date; no migrations to apply')
    } else {
      logger.info({ count: appliedNow.length, migrations: appliedNow }, 'All migrations applied')
    }

    await closePool()
    process.exit(0)
  } catch (error) {
    logger.error({ error }, 'Error running migrations')
    await closePool()
    process.exit(1)
  }
}

if (require.main === module) {
  void runMigrations()
}
