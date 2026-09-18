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
// REL-1 (#586): the generated v2 relation manifest. Mirrors what
// `init-scaffold.ts` emits into a real consumer's database.module.ts —
// `drizzle({ client, relations })` with `DrizzleDB` parameterised by the
// manifest type, so `db.query.<table>.findMany({ with: … })` is typed.
import { relations } from '@gen/generated/relations';

export { DRIZZLE };
export type DrizzleDB = NodePgDatabase<typeof relations>;

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
        // Drizzle 1.0: config object, `schema` removed (DRZ-2, #584);
        // `relations` is the generated manifest (REL-1, #586).
        return drizzle({ client: pool, relations });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
