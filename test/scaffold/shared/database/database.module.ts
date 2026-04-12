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
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../schema';
import { DRIZZLE } from '../constants/tokens';

export { DRIZZLE };
export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => {
        const pool = new Pool({
          connectionString:
            process.env.DATABASE_URL ??
            'postgresql://postgres:postgres@localhost:5432/scaffold_test',
        });
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
