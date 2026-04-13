/**
 * Test infrastructure — DB lifecycle management.
 *
 * Provides a Drizzle client connected to the Docker Postgres instance
 * from docker-compose.yml. Used by both repository and HTTP tests.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import * as schema from '../schema';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/scaffold_test';

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/** Get or create the shared Drizzle client. */
export function getTestDb() {
  if (!db) {
    pool = new Pool({ connectionString: DATABASE_URL });
    db = drizzle(pool, { schema });
  }
  return db;
}

/** Truncate all known tables. Call between tests for isolation. */
export async function truncateAll() {
  const client = getTestDb();
  await client.execute(sql`TRUNCATE contacts CASCADE`);
}

/** Close the connection pool. Call in afterAll. */
export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
