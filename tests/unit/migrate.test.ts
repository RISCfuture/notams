import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Pool, PoolClient } from 'pg'
import { runPendingMigrations } from '../../src/scripts/migrate'

/**
 * Minimal fake Postgres pool + client. Records every query and stores
 * schema_migrations rows / pg_tables responses in-memory so we can exercise
 * the migration runner without a real database.
 */
function createFakePool(opts: { existingTables?: string[] } = {}) {
  const existingTables = new Set(opts.existingTables ?? [])
  const appliedMigrations = new Set<string>()
  const executed: string[] = []
  const clientLog: string[] = []
  let txState: 'none' | 'open' | 'committed' | 'rolled-back' = 'none'
  let failNextMigrationSql: string | null = null

  const runQuery = (
    text: string,
    params: readonly unknown[] | undefined,
    log: string[],
  ): { rows: unknown[] } => {
    log.push(text.trim().split(/\s+/).slice(0, 3).join(' '))

    if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(text)) {
      existingTables.add('schema_migrations')
      return { rows: [] }
    }

    if (/SELECT filename FROM schema_migrations/i.test(text)) {
      return { rows: [...appliedMigrations].map((filename) => ({ filename })) }
    }

    const firstParam = typeof params?.[0] === 'string' ? params[0] : ''

    if (/FROM pg_tables/i.test(text)) {
      return { rows: [{ exists: existingTables.has(firstParam) }] }
    }

    if (/INSERT INTO schema_migrations/i.test(text)) {
      appliedMigrations.add(firstParam)
      return { rows: [] }
    }

    if (text.trim() === 'BEGIN') {
      txState = 'open'
      return { rows: [] }
    }
    if (text.trim() === 'COMMIT') {
      txState = 'committed'
      return { rows: [] }
    }
    if (text.trim() === 'ROLLBACK') {
      txState = 'rolled-back'
      return { rows: [] }
    }

    // Otherwise this is a migration body SQL statement.
    executed.push(text)
    if (failNextMigrationSql !== null && text.includes(failNextMigrationSql)) {
      throw new Error(`simulated failure on: ${failNextMigrationSql}`)
    }
    return { rows: [] }
  }

  const asAsync = (text: string, params: readonly unknown[] | undefined, log: string[]) =>
    new Promise<{ rows: unknown[] }>((resolve, reject) => {
      try {
        resolve(runQuery(text, params, log))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })

  const client = {
    query: (text: string, params?: readonly unknown[]) => asAsync(text, params, clientLog),
    release: () => {
      /* noop */
    },
  } as unknown as PoolClient

  const pool = {
    query: (text: string, params?: readonly unknown[]) => asAsync(text, params, []),
    connect: () => Promise.resolve(client),
  } as unknown as Pool

  return {
    pool,
    get appliedMigrations() {
      return appliedMigrations
    },
    get executedMigrationSql() {
      return executed
    },
    get txState() {
      return txState
    },
    setFailOn(marker: string) {
      failNextMigrationSql = marker
    },
  }
}

describe('runPendingMigrations', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migrate-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeMigration(name: string, body: string): void {
    writeFileSync(join(dir, name), body)
  }

  it('applies all pending migrations on a fresh database', async () => {
    writeMigration('001_create_notams.sql', '-- create notams\nSELECT 1;')
    writeMigration('002_create_tokens.sql', '-- create tokens\nSELECT 2;')
    writeMigration('004_create_schema_migrations.sql', '-- tracking table\nSELECT 3;')

    const fake = createFakePool()
    const applied = await runPendingMigrations(fake.pool, dir)

    // 004 is recorded via pre-existing-table detection (its table gets created
    // by CREATE TABLE IF NOT EXISTS before we scan), so it should NOT re-run.
    // 001 and 002 should run.
    expect(applied).toEqual(['001_create_notams.sql', '002_create_tokens.sql'])
    expect(fake.appliedMigrations.has('001_create_notams.sql')).toBe(true)
    expect(fake.appliedMigrations.has('002_create_tokens.sql')).toBe(true)
    expect(fake.appliedMigrations.has('004_create_schema_migrations.sql')).toBe(true)
  })

  it('skips migrations that have already been applied', async () => {
    writeMigration('001_create_notams.sql', '-- create notams\nSELECT 1;')
    writeMigration('004_create_schema_migrations.sql', '-- tracking\nSELECT 3;')

    const fake = createFakePool()
    await runPendingMigrations(fake.pool, dir)
    const secondRun = await runPendingMigrations(fake.pool, dir)

    expect(secondRun).toEqual([])
  })

  it('back-fills legacy migrations when their target tables already exist', async () => {
    writeMigration('001_create_notams.sql', 'SELECT 1;')
    writeMigration('002_create_tokens.sql', 'SELECT 2;')
    writeMigration('004_create_schema_migrations.sql', 'SELECT 4;')

    // Simulate a database that already has the legacy tables but no
    // schema_migrations tracking yet.
    const fake = createFakePool({ existingTables: ['notams', 'api_tokens'] })
    const applied = await runPendingMigrations(fake.pool, dir)

    expect(applied).toEqual([])
    expect(fake.appliedMigrations.has('001_create_notams.sql')).toBe(true)
    expect(fake.appliedMigrations.has('002_create_tokens.sql')).toBe(true)
    expect(fake.executedMigrationSql).toHaveLength(0)
  })

  it('rolls back and throws when a migration fails', async () => {
    writeMigration('001_create_notams.sql', 'SELECT 1;')
    writeMigration('002_bad.sql', 'BAD_MARKER_QUERY;')
    writeMigration('004_create_schema_migrations.sql', 'SELECT 4;')

    const fake = createFakePool()
    fake.setFailOn('BAD_MARKER_QUERY')

    await expect(runPendingMigrations(fake.pool, dir)).rejects.toThrow(/BAD_MARKER_QUERY/)

    // 001 should have applied cleanly; 002 must not be recorded.
    expect(fake.appliedMigrations.has('001_create_notams.sql')).toBe(true)
    expect(fake.appliedMigrations.has('002_bad.sql')).toBe(false)
    expect(fake.txState).toBe('rolled-back')
  })

  it('records migration 004 as applied after first run', async () => {
    writeMigration('004_create_schema_migrations.sql', '-- tracking\nSELECT 3;')

    const fake = createFakePool()
    const applied = await runPendingMigrations(fake.pool, dir)

    expect(applied).toEqual([])
    expect(fake.appliedMigrations.has('004_create_schema_migrations.sql')).toBe(true)
  })
})
