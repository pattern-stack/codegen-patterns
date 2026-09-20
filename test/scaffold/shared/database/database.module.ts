/**
 * DatabaseModule — provides the DRIZZLE injection token globally.
 *
 * DESIGN DECISION (A15):
 * The generated repository imports DRIZZLE from '@shared/constants/tokens'.
 * This module uses that same constant (re-exported from shared/constants/tokens.ts)
 * so the token string matches exactly. The path alias @shared/* resolves to
 * test/scaffold/shared/ via tsconfig.json paths, making the token value identical
 * at runtime.
 *
 * Option A was chosen: a single source of truth at @shared/constants/tokens
 * rather than duplicating the token string in multiple places.
 */
import { Module, Global } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DRIZZLE } from '@shared/constants/tokens';
import { scaffoldDatabaseUrl } from '../../harness-env';

export { DRIZZLE };
export type DrizzleDB = NodePgDatabase;

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => {
        // This checkout's scaffold Postgres (`harness-env.ts`), never an
        // ambient DATABASE_URL or a fixed 5432 — either can be another
        // worktree's or a dev database.
        const pool = new Pool({ connectionString: scaffoldDatabaseUrl() });
        // Drizzle 1.0: config object, `schema` removed (DRZ-2, #584).
        return drizzle({ client: pool });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
