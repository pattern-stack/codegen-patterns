# TABLE-0 — The SQL table name is not the entity's code name

**Status:** implemented · **Issue:** #848 · **Stacked on:** #839 (#791)

## Problem

`entity: { name, plural, table }` validated `table` — it was even required — but no emitter used it for the table
name. `entity.ejs.t` emitted `pgTable('<plural>', …)`, so `plural` decided four things at once: the SQL table, the
Drizzle export, the module folder and the relations-manifest / `db.query` key. A host adopting an existing schema whose
table names differ from its domain vocabulary (a renamed concept over a legacy table) could not say so: the generated
code had to carry the table's name everywhere, and the YAML's `table:` silently lied.

## Decision

Two names, one rule — `sqlTableName(source, projectPrefix)` in `src/config/table-naming.ts` (junctions:
`junctionTableName` in `src/config/junction-naming.ts`, the same rule over the derived junction plural).

| Key | Where | Meaning |
|---|---|---|
| `table:` | entity block, junction YAML | The literal SQL table name, used **verbatim** — no prefix reaches it. |
| `table_prefix:` | entity block, junction YAML | Overrides the project prefix for this table; `''` opts out. Exclusive with `table`. |
| `tables.prefix` | `codegen.config.yaml` | Project default prefix, default `''`. |

Resolution: `table` → else `<table_prefix ?? tables.prefix><plural>`. With neither key and no project prefix the
SQL name is `plural`, so existing output is byte-identical (`just test-baseline` is unchanged).

### What follows the SQL name

- the `pgTable('…')` argument (entities and junctions);
- every index / unique / constraint name stemmed on the table (`<table>_<col>_idx`, `<table>_<cols>_uniq`,
  `uq_<table>_…external_id`);
- a field-level `foreign_key: <table>.<column>` — it names a SQL table, resolved through `entityLookup.byTable` to the
  owning entity, whose **export** the `.references()` callback and the import then name;
- the owned-table set (#636) a host-owned `foreign_key:` is checked against;
- the Electric shape's `table` param (entities and junction collections) — the URL-path form keeps the plural, which is
  the API route;
- the semantic model's `tableName` (entities and junctions);
- `ParsedEntity.table` and `EntityRegistryEntry.table` (analyzer output, the `foreign_key` consistency check).

### What does not

The Drizzle export, the `db.query.<plural>` / relations-manifest key, the module folder, file stems, class names and the
REST route all stay on `plural` / `name`. Drizzle carries the SQL name on the table object, so the relations manifest,
RQBv2 includes and the runtime base classes need nothing: an include through `db.query.tickets` compiles to SQL over
the real table (pinned by `src/__tests__/cli/table-naming-generation.test.ts`, which generates a project and compiles
an include to SQL).

### `entity.table:` is the SQL name — it is not deleted, and there is no `table_name:`

`table:` was already the key an author reaches for, and it already said "the table". It is kept, made optional, and
finally honoured: it is the literal SQL table name. Every in-repo YAML and every known consumer YAML wrote `table:`
equal to `plural`, so honouring it is byte-identical for all of them (`src/__tests__/backend/table-naming-templates.test.ts`
pins that), and the fixtures simply omit it. A YAML whose `table:` differs from `plural` now renames its table — the
behaviour the key always promised; the CHANGELOG calls it out. There is no second key: `table_name:` is declared only
so that writing it fails validation naming `table:` (a `.strict()` unknown-key error alone would not point anywhere).

Decided by Doug on #855 (2026-11-12): reuse `table:` over adding `table_name:`. The first draft of this PR deleted
`table:` (an unknown-key error) and added `table_name:`, which made every existing entity YAML fail validation for a
rename that bought nothing — the standing rule allows a break only when it is how the design would be drawn from
scratch, and from scratch the key is `table:`.

### The prefix is a required argument

Every reader that emits a name takes the project prefix as a **required** argument: `sqlTableName`,
`junctionTableName`, `loadEntities`, `loadEntityRegistry`, `createEntityLookup`, `loadOwnedTableNames`.
`sqlTableName` throws on a non-string prefix. One reader defaults instead: `buildBackendLocals` falls back to the
schema default when `baseLocals.tablePrefix` is absent, exactly as it does for `baseLocals.tenancyColumn` (#791) — its
one production caller, `templates/entity/new/prompt.js`, always passes the config value, and ~250 unit-test call sites
build locals by hand. Making both keys required there is one change for both, not this PR's. A forgotten prefix must not silently emit an unprefixed table — the
CLAUDE.md gate rule (c) failure shape (a unit test caught exactly this: an undefined prefix concatenated into
`undefinedopportunity_contacts`).

## ADR-0004 alignment (not built)

ADR-0004 (a consumer's data-layer naming decision) chose "bounded context as a table prefix now
(`<context>__<table>`), a Postgres schema later (`pgSchema('<context>').table('<table>')`)". `table_prefix` is the
mechanism that decision needs: a context prefix is the value `'<context>__'`. The deferred knob that derives the prefix
from `entity.context` — and later swaps prefix for `pgSchema` — replaces step 2's prefix source inside `sqlTableName`;
the prefix/base split it needs is already step 2's shape. An explicit `table` stays outside both, because it names
a table the host owns.

## Two entities over one table (#800)

One SQL table has one owning definition. `sqlTableCollisions` (`src/config/table-naming.ts`) is the check, over
entities **and** junctions in one namespace — `table:` and prefixes let two definitions meet on a table without
sharing a plural, so the plural check alone cannot see it. It runs in `entity new` / `junction new`'s shared
pre-flight (`preflightEntityTargets`, a run-level rejection before anything is written) and in `analyzeDomain`
(`entity validate`, entities only — it is not given the junction definitions). The hygen entity lookup also refuses
two entity YAMLs on one table (and, separately, two that share a plural — they would share an export) as a last line.
First-class `relationship:` tables are not in the set: they keep their own `table:` rule until #679 folds them into
junctions. That is deliberate: a second entity over the same table is only meaningful with a
distinguishing filter (`artifacts where type = 'x'`), which is #800's design. TABLE-0 is the precondition — before it,
the second entity's export had to equal the table, so two entities could not even be declared — and the collision
error names #800.

## Not changed

- `pgEnum` type names do not take the prefix (#346 / #479 own enum naming).
- First-class `relationship:` YAMLs keep their own `table:` key (default `${name}s`, #700); #679 folds them into
  junctions, which already follow this rule.
- Junction exports stay camelCase (`ticketTags`) while entity exports are snake (`ticket_revisions`) — the relations
  manifest therefore mixes the two. Fixing that renames every junction export, so it is a separate, breaking change
  (#849).
