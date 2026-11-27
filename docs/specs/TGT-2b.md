# TGT-2b: the `sqlite + drizzle` pair is registered, and a SQLite project gets its storage layer

**Status:** implemented · **Decision:** ADR-047 · **Issue:** none · **Follows:** TGT-2a (#954)

## Problem

TGT-2a built the SQLite renderers and DDL as library code, proven by a parity gate, but nothing reached a project:
`target: { database: sqlite, orm: drizzle }` was refused, and every template was `pg-core`. The Nest layers above
the table (repository, service, controller, module, DTOs, use cases) are `node-postgres`-typed all the way down,
through `runtime/base-classes` and `DrizzleClient = NodePgDatabase`. The first SQLite consumer, crew, is Nest-free
(codegen-targets d12): its stores will come from `wiring: plain` (G7).

## Decision

- **The pair is registered.** `TARGET_PAIRS` has two rows, and `TARGET_RENDERERS` binds the sqlite row to TGT-2a's
  renderers. The editor JSON Schema offers both pairs, and the "Supported pairs:" docs name both.
  - `target:` now goes through #941's union path: a refusal is one issue at `target`, naming the pair and both
    supported pairs.
  - Each row carries two database facts:
    - `identifierMaxBytes`: 63 on Postgres, none on SQLite. C5 reads it.
    - `layers`: `'nest'` on Postgres, `'storage'` on SQLite.
- **A storage-only target writes, per entity**, the `sqliteTable` module (`entity-sqlite.ejs.t`) and
  `<entity>.sql` (`entity-sql.ejs.t`, the `@generated` banner with SQL's `--` leader). It also writes the schema
  barrel, and nothing else:
  - every Nest-layer output path is null;
  - `entity new` stops after the schema barrel, so there is no modules barrel, and no relations manifest (its scopes
    import the Nest runtime). Subsystems, events, the bridge, the jobs scope union, orchestration, the frontend and
    integrations are skipped too;
  - both skips are printed, naming what comes with `wiring: plain` (G7). Neither is silent (gate rule c).
- **`renderSqliteTable`** (`src/targets/drizzle/sqlite/table.ts`) is the one owner of a SQLite module's body: column
  lines with reference suffixes, extra-config entries plus SQLite's storage CHECKs, and its imports. The template
  prints it, and the parity gate compiles exactly it; the old harness is deleted.
- **Reference and foreign-key facts carry their target's SQL table and column names.** A table's facts therefore
  stand alone, so one entity's `.sql` needs no other table's facts. `renderSqliteDdl` writes a reference outside the
  rendered set as is, and SQLite checks it when a row is written.
- **The rule: facts can come from rows as well as YAML** (ADR-047). Facts are JSON-serializable plain data with no
  template text. Derivations take parsed definitions and plain lookups, and renderers read facts only. This is the
  precondition for a later interpreted mode that builds Zod, Drizzle tables and DDL at runtime from domain rows.
  `facts-are-data.test.ts` holds it.

## Proof

- **Postgres byte-identical.** No golden or snapshot changed, and unit, baseline and junction pass at every commit.
- **`just test-sqlite`** (in `just test-all`) runs `test/sqlite/`:
  - **the smoke**, over the whole baseline fixture set, tenant-scoped entities and the joined-table family included:
    - `entity new --all` runs through the real CLI on a SQLite config;
    - it writes exactly one table module and one `.sql` per entity, and no Nest file, and says so;
    - `tsc` must run and find nothing located in the project;
    - every `.sql` applies twice with foreign keys on;
    - through `sqlite-proxy` over a positional handle, the **generated** modules select every declared column of
      every table, and a row round-trips;
  - **the parity gate**: drizzle-kit's SQL from `renderSqliteTable` against `renderSqliteDdl`, compared through
    SQLite's catalogue.
- **`facts-are-data.test.ts`** checks three things:
  - every table's facts equal their JSON round trip strictly;
  - the SQLite DDL, the sqlite table text and Postgres's constraint text are byte-equal from the copy;
  - no fact value is a function, a non-plain object or template text.

## Review (2026-11-26)

`/code-review` found 4 important issues and 6 nits. All are fixed except one important finding, which is checked and
kept:
- **`--dry-run` on a storage-only target** now predicts the real run: the schema barrel only, exit 0.
- **The schema barrel** on a storage-only target lists entity tables only, with no junction or relationship modules.
- **`junction new` / `relationship new`** refuse a storage-only target by name and exit 1, instead of writing
  pg-core text silently (`src/cli/shared/storage-only.ts`). The smoke tests all three.
- **JSON output** keeps the real run's shape (`totals`, `succeeded`, `failed[]`, `barrels`), with
  `storageOnly: true`.
- **Barrels:** `BarrelResult.modulesBarrelWritten`, and the directory creation names the file on failure.
- **Smaller fixes:**
  - the skip count no longer counts the entity file;
  - the `.sql` banner is `renderGeneratedBanner({ comment: '--' })` (`generatedSqlBanner`), not a regex over the TS
    banner;
  - C5's limit is required, comes from the pair's row, and names the database.
- **Kept:** the Postgres path resolves a `belongs_to` target's SQL table from its YAML (`sqlTableOf`), so a caller
  without a full entity lookup now fails loudly instead of rendering. Every generator path passes a full lookup, and
  the unit, baseline and junction suites pass. Gate rule c prefers the loud failure to a guessed table name.

## Differs from the plan

- **The table template was not made pair-neutral.** Postgres's `entity.ejs.t` still writes its inline text (the
  soft-delete warning per `on_delete`, the `match:` comments, the enum const names, the behaviour columns). Moving
  that to the facts loop would rewrite the generator's most-printed text for no new capability.
  - A SQLite table renders entirely from facts in its own template, chosen by `outputPaths`.
  - Postgres is untouched, and byte-identical by construction.
  - Postgres's template moves to the facts loop when its inline text does (the behaviour-columns TGT-N).
- **No SQLite `project init`.** The smoke writes its config by hand. A minimal scaffold (config, entities dir,
  tsconfig) is a follow-up, named in the handoff.
- **No enums leaf on SQLite.** There is no enum type, so no `<entity>.enums.ts`; this came out of
  `outputPaths.enums` being null, not a pair flag.

## Named gaps

- **No CHECK for an enum array on SQLite.** A `string_array` with `choices` is JSON TEXT, and SQLite forbids
  subqueries in a CHECK, so `json_each` can't be used there. The default (Doug, 2026-11-26) is to close it in the
  record layer: the generated Zod record schema, with G3's record half. Postgres's `enum[]` enforces it.
- **`decimal` ordering is lexical on SQLite** (TEXT storage). G6's ordered finders must `CAST(x AS REAL)` for a
  decimal `order:`.
- **An upsert over a NULLS NOT DISTINCT unique** must name the index's expressions, `ON CONFLICT (ifnull("c", X'00'),
  …)` (proven in `sqlite-ddl.test.ts`). It is G7's or G4/G5's to emit.
- **Tenant scoping on SQLite**: the tables render (the `ifnull` emulation), but nothing scopes reads by tenant until
  G7 builds a repository.
- **One `.sql` per entity.** G8's module grouping gathers a module's tables into `<module>.sql`.
- **The junction and relationship pipelines are Postgres-only.** `junction new` / `relationship new` on a SQLite
  target still emit pg-core text. This is named for G8 / #679.
