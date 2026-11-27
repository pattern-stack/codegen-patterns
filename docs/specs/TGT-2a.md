# TGT-2a: the `sqlite + drizzle` renderers, SQLite DDL, and SQLite storage

**Status:** implemented · **Decision:** ADR-047 · **Issue:** none · **Follows:** TGT-0, TGT-0b, TGT-1 · **Next:** TGT-2b

## Problem

TGT-0 and TGT-1 put a field's columns and a table's constraints behind the target as facts plus a renderer, but only
one pair existed. A second database needs three things:
- its own text: Drizzle `sqlite-core`, not `pg-core`;
- a storage choice per field type, since SQLite has no timestamp, enum, array or exact-numeric type;
- a database's own DDL. A Nest-free consumer applies a module's `.sql` at compose time (`migrate(ddl)`), and nobody
  runs `drizzle-kit push` (G9 in the crew gap analysis).

None of it could be checked against anything but hand-typed strings unless the DDL and the Drizzle text came from the
same facts.

## Decision

```
YAML ──► deriveTableColumns            src/derived/tables/       ColumnFact per column (id, inherited, match,
            │                                                   belongs_to, field, behaviors, tenant); types only
            ├─► constraint facts         src/derived/constraints/  (TGT-1) + ConstraintFact; recorded as rendered
            │
            ├─► drizzle/sqlite           src/targets/drizzle/sqlite/{columns,constraints}.ts   sqlite-core text
            │       └ shares            src/targets/drizzle/shared.ts   (sql predicate, index, foreignKey, check)
            └─► SQLite DDL               src/targets/sqlite/{ddl,checks}.ts   CREATE TABLE / INDEX IF NOT EXISTS
```

- **`deriveTableColumns` is the one owner of a table's column list.** `entityTableColumns` is deleted, and
  entity-locals' `tableColumns` is a projection. The Postgres template still prints each group's own text, so its
  bytes are unchanged.
- **The table's constraint facts are what it renders.** `buildBackendLocals` wraps its constraint renderer so each
  reference, index, unique, foreign key and check it renders is also recorded (`tableFacts`, a local no template reads
  yet). The `external_id_tracking` unique's text is still inline (TGT-1b, after #917); its fact is recorded beside it.
- **SQLite storage** (G3's storage half), proven by the spike first:

  | Kind | Column (sqlite-core) | DDL |
  |---|---|---|
  | string | `text('x')`, `text('x', { length: n })` + CHECK | `TEXT`, `TEXT(n)` + `CHECK (length(x) <= n)` |
  | integer | `integer('x')` | `INTEGER` |
  | boolean | `integer('x', { mode: 'boolean' })` | `INTEGER` (0/1) |
  | decimal | `text('x')` | `TEXT`: NUMERIC affinity turns `'12.50'` into `12.5` |
  | uuid, date | `text('x')` | `TEXT` |
  | instant | `text('x')` | `TEXT`, ISO 8601: UTC with `Z`, or wall-clock without an offset when `timezone: false` |
  | json, arrays | `text('x', { mode: 'json' })` (`.$type<…[]>()` for an array) | `TEXT` |
  | enum | `text('x', { enum: [...] })` + CHECK | `TEXT` + `CHECK (x IN (…))` |
  | id | `text('id').primaryKey().notNull().$defaultFn(() => globalThis.crypto.randomUUID())` | `TEXT PRIMARY KEY NOT NULL`, because SQLite lets a non-INTEGER primary key hold NULL, repeatedly |

  The `now` default is `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`, or `date('now')` for a date, in both renderings.
  Missing-vs-null (G3's record half) comes with the Zod 4 emit.
- **NULLS NOT DISTINCT on SQLite** (a tenant-scoped entity's default) is a unique index over `ifnull(<col>, X'00')`
  for every column. A BLOB never equals a TEXT or an INTEGER, so NULLs compare equal to each other and to nothing
  else, which is exactly the rule. This is decided in the build (the plan said refuse it), so that the tenant-scoped
  base of the joined-table family renders.
- **The DDL is database-level**, so any ORM on SQLite gets the same `.sql`.
  - A single-column reference is written inline.
  - Composite FKs, a referenced UNIQUE and every CHECK are table constraints; other uniques and indexes are
    `CREATE INDEX`.
  - A reference's export resolves to its SQL table within the set being rendered.
  - Tables are written in reference order where one exists. Two tables that reference each other (#631) are written
    in declaration order, since SQLite checks foreign keys on write. A target outside the set is an error naming it.
  - Columns in an expression are quoted, so `order` and `group` parse. An author's `where:` is copied as written, so
    on SQLite it must be SQLite SQL: no `::text`, no `ILIKE`.
  - The two renderings make the same unique decision, and both refuse the shapes they can't build: NULLS NOT DISTINCT
    that is also partial or referenced, and a referenced unique that is partial.
- **`ColumnRenderer` / `ConstraintRenderer` are generic over the pair key.** That lets `drizzle/sqlite` exist before
  its `TARGET_PAIRS` row, which **TGT-2b** adds together with the templates that print this text and the per-entity
  `.sql` emission. Until then nothing generates a SQLite app, and the renderers and the DDL are exercised by tests.

## Room left (nothing built)

- `ColumnFact.path` is separate from `name`, for value-object prefixed columns (PROPOSAL-value-objects, phase 1).
- A primary key isn't assumed to be `id` only (phase 2's `identity:`).
- An `order: seq` column, or #952's second unique integer column, is an ordinary integer fact.
- All-or-none and union CHECKs are `CheckFact`s. The spike proves an all-or-none CHECK refuses a half-set pair.

## Proof

1. **The spike** (`sqlite-proxy-roundtrip.test.ts`): `drizzle-orm/sqlite-proxy` over a `bun:sqlite` handle shaped
   like crew's `SqlHandle` (run + positional `values`).
   - Every kind round-trips. `get` on no rows is `undefined`, and joins with repeated names map by position.
   - The CHECKs refuse a bad enum, an over-long string and a half-set value object.
   - This is the d1 claim the crew plan rests on.
2. **Exact text:** per column kind (`drizzle-sqlite-columns.test.ts`), and per constraint shape plus the storage
   CHECKs (`drizzle-sqlite-constraints.test.ts`).
3. **The DDL golden:** `test/sqlite-ddl-golden/baseline.sql`, 15 baseline tables including the joined-table family.
   - It applies twice to `bun:sqlite` with foreign keys on, and `foreign_key_check` is clean.
   - On rows: NULL-tenant conflicts, per-tenant codes, the enum and length CHECKs, and the enum default.
4. **The parity gate** (`just test-sqlite-parity`, in `just test-all`):
   - the drizzle/sqlite renderers write a `sqlite-core` module for every baseline table, and drizzle-kit
     `generate --dialect=sqlite` turns it into SQL;
   - it is applied beside the DDL and compared through `table_info`, `foreign_key_list`, `index_list` /
     `index_xinfo` and the CHECK count;
   - all 15 tables match, and dropping NOT NULL from the DDL fails 14.
5. **Postgres unchanged:** the golden directories don't change, and unit, baseline and junction tests pass at every
   commit.

## Review (2026-11-26)

`/code-review` found 5 important issues and 5 nits. All were fixed here except the upsert target, which is TGT-2b's.
- **A reference cycle** was an error; it now renders and applies.
- **The id** gained NOT NULL in both renderings.
- **A numeric default on a `decimal`** was printed bare onto a TEXT column; it is now quoted, as Postgres does.
- **Expression columns** are quoted.
- **The unique decision order** is now one order with the same refusals in both renderings.
- **`deriveTableColumns` order:** `belongs_to` now comes before `match:`-derived columns, which is the template's real
  order; the old `entityTableColumns` had them the other way round.
- **`globalThis.crypto`.**
- **The parity gate** now compares CHECK bodies and index SQL, not just counts. Dropping the `ifnull` wrap from the
  DDL alone fails it.
  - Its stricter comparison found **drizzle-kit dropping NOT NULL from a SQLite primary key**, even with `.notNull()`.
  - The DDL (what a consumer applies) keeps it, and the gate normalises exactly that, by name.
- **The upsert target:** an `upsertByNaturalKey` over a NULLS NOT DISTINCT unique must name the index's expressions,
  `ON CONFLICT (ifnull("c", X'00'), …)`. A test shows that works on rows. Emitting it is TGT-2b's, as is a
  `timestampColumn` whose default isn't Postgres's `.defaultNow()`.

### Found after the review, on rebasing onto #953

- **The table's field facts were incomplete.** `deriveTableColumns` was fed the template's processed field records,
  which leave out `elementType`, `isArray` and `withTimezone`, and, before #953, `default` too.
  - So the first golden typed integer columns as TEXT, lost arrays, and printed `DEFAULT 'undefined'`.
  - Both renderings read the same facts, so the parity gate couldn't see it.
- **Fixed in three ways:**
  - buildBackendLocals hands `deriveTableColumns` the real `FieldFacts`;
  - `fieldColumn` refuses an incomplete record (gate rule c);
  - a new test checks every field column of the baseline facts against the field's own YAML (kind, array, default).
    It is independent of both renderings, and the old input fails all 15 entities on it.
- **A named gap:** an array of enum values (`string_array` + `choices`) gets no CHECK on SQLite. Postgres's `enum[]`
  type enforces it; SQLite would need a `json_each` CHECK. It is left for whoever needs it.

## Differs from the plan

- **`decimal` is TEXT, not NUMERIC** (the spike's finding). The trade-off is that ordering by a decimal column is
  lexical, so numeric order needs `CAST(x AS REAL)` in that query.
- **NULLS NOT DISTINCT is emulated, not refused** (above).
- **`TEXT(n)` in the DDL**, which the parity gate found: Drizzle declares a length, and the DDL says the same thing.
- **The per-database identifier limit (C5, 63 bytes) moves in TGT-2b**, where C5 first runs for SQLite. SQLite has no
  limit.
- **The parity harness assembles `sqlite-core` modules itself**: there is no sqlite template until TGT-2b. That
  template must print what the harness prints, and its smoke will hold it to that.

## Next (TGT-2b)

- The pair's `TARGET_PAIRS` row, `TARGET_RENDERERS` entry, and the per-database identifier rule.
- Per-pair entity and repository templates: `sqliteTable`, behaviour columns through the renderers, the
  `AnySQLiteColumn` import, and the `sql` import when a default uses it.
- Base classes typed on the pair, and per-entity `.sql` emission from `tableFacts`.
- An `upsertByNaturalKey` on SQLite must target the `ifnull(…)` expression index (`ON CONFLICT (ifnull(c, X'00'), …)`;
  `sqlite-ddl.test.ts` shows it works).
- The behaviour time columns: Postgres's template chains `.defaultNow()` onto `timestampColumn`, which sqlite-core's
  `text` doesn't have. The pair's renderer has to own the whole behaviour column there, including its default.
