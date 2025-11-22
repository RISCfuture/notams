import dotenv from 'dotenv';
dotenv.config();

import { readFileSync } from 'fs';
import { join } from 'path';
import { pool } from '../src/config/database';

const MIGRATIONS_DIR = join(__dirname, '../migrations');

const migrations = ['001_create_notams.sql', '002_create_tokens.sql'];

beforeAll(async () => {
  // Verify we're using test database
  const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!dbUrl?.includes('notams_test')) {
    throw new Error('Tests must run against notams_test database');
  }

  // Drop all tables to ensure clean state
  await pool.query('DROP TABLE IF EXISTS notams CASCADE');
  await pool.query('DROP TABLE IF EXISTS api_tokens CASCADE');

  // Run migrations
  for (const migration of migrations) {
    const migrationPath = join(MIGRATIONS_DIR, migration);
    const sql = readFileSync(migrationPath, 'utf-8');
    await pool.query(sql);
  }
});

beforeEach(async () => {
  // Clean up test data between tests
  await pool.query('DELETE FROM notams');
});

afterAll(async () => {
  // Close database connection
  await pool.end();
});
