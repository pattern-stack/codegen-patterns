# Drizzle in a generated project

`@pattern-stack/codegen` targets the **Drizzle 1.0 line**. `drizzle-orm` is a
**peer dependency** (`^1.0.0-rc.4`, which admits GA `1.0.0`), not a bundled
dependency: the generated code and the package's runtime base classes must
compile against **one** `drizzle-orm` copy, or TypeScript treats their
`PgTable` values as unrelated types. See
[CONSUMER-SETUP.md](../CONSUMER-SETUP.md#troubleshooting).

Install both halves yourself:

```bash
bun add drizzle-orm@1.0.0-rc.4
bun add -D drizzle-kit@1.0.0-rc.4
```

Pin **exactly** while the line is in prerelease. Codegen's own harnesses do.

## The client

`codegen project init` emits `database.module.ts` with the 1.0 constructor:

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export type DrizzleDB = NodePgDatabase;

// …
return drizzle({ client: pool });
```

Two things changed from the 0.x form:

| 0.x | 1.0 |
|---|---|
| `drizzle(pool, { schema })` | `drizzle({ client: pool })` |
| `ReturnType<typeof drizzle<typeof schema>>` | `NodePgDatabase` |

`schema` was **removed** from the pg config type
(`DrizzlePgConfig = Omit<DrizzleConfig, 'schema'>`), not renamed. The generic
slot on `NodePgDatabase` is now the *relations manifest*
(`NodePgDatabase<TRelations extends AnyRelations = EmptyRelations>`), which is
what `defineRelations()` produces. Codegen does not emit a manifest yet, so
`NodePgDatabase` with its default is the accurate type. When the generator
starts emitting one it will be passed as `drizzle({ client: pool, relations })`
and the type will pick it up.

Nothing else in a generated project reads the schema object: repositories
import their table directly. The `src/generated/schema.ts` barrel exists for
drizzle-kit and for code that imports tables by name.

## drizzle-kit

Codegen never runs drizzle-kit except `codegen dev`, which shells
`drizzle-kit push` when a `drizzle.config.ts` is present. Migrations are yours.

`defineConfig` is unchanged:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/generated/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

**The `generate` output layout changed.** Verified against `drizzle-kit@1.0.0-rc.4`:

```
drizzle/
  20260917225701_goofy_the_santerians/
    migration.sql
    snapshot.json
```

- One **directory per migration**, named `<timestamp>_<name>`, holding
  `migration.sql` and its `snapshot.json`. 0.x wrote `<timestamp>_<name>.sql`
  at the top level with snapshots under `meta/`.
- There is **no `meta/_journal.json`**. Ordering comes from each snapshot's
  `prevIds`.
- The snapshot format is `version: 8`, `dialect: "postgres"`, with top-level
  keys `ddl`, `dialect`, `id`, `prevIds`, `renames`, `version`.

Codegen does not convert an existing 0.x migration folder, and does not intend
to: kit's own tooling owns that. If you have 0.x history, either keep it and
start the 1.0 folder fresh, or squash to a baseline — a decision about your
database, not about codegen.
