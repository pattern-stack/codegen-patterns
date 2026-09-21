/**
 * Test infrastructure — DB lifecycle management.
 *
 * Provides a Drizzle client connected to the Docker Postgres instance
 * from docker-compose.yml. Used by both repository and HTTP tests.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { scaffoldDatabaseUrl } from '../harness-env';
// REL-1 (#586): the generated v2 relation manifest, so `db.query.*` traversals
// resolve in the integration suite exactly as they do in a real consumer.
import { relations } from '@gen/generated/relations';

// Falls back to this checkout's derived port, not a fixed 5432 — sibling
// worktrees each publish their own (`harness-env.ts`).
const DATABASE_URL = scaffoldDatabaseUrl();

let pool: Pool | null = null;
let db: NodePgDatabase<typeof relations> | null = null;

/** Get or create the shared Drizzle client. */
export function getTestDb() {
  if (!db) {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Drizzle 1.0: config object, `schema` removed (DRZ-2, #584);
    // `relations` is the generated manifest (REL-1, #586).
    db = drizzle({ client: pool, relations });
  }
  return db;
}

/** Truncate all known tables. Call between tests for isolation. */
export async function truncateAll() {
  const client = getTestDb();
  await client.execute(
    // Every table in the public schema, so this list cannot go stale as the
    // subsystem schemas evolve. It used to name `job_queue`, a table the jobs
    // subsystem stopped emitting, which failed the whole TRUNCATE (GATE-1, #599).
    sql`
      DO $$
      DECLARE tables text;
      BEGIN
        SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
          INTO tables
          FROM pg_tables
         WHERE schemaname = 'public';
        IF tables IS NOT NULL THEN
          EXECUTE 'TRUNCATE ' || tables || ' CASCADE';
        END IF;
      END $$;
    `,
  );
}

/** Close the connection pool. Call in afterAll. */
export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
