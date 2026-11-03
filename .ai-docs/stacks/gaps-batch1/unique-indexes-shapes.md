---
issue: pattern-stack/codegen-patterns#784
github_issue: https://github.com/pattern-stack/codegen-patterns/issues/784
stack: gaps-batch1
stack_position: "A2. field-unique-constraint (#511) → unique-indexes-shapes (#784) → datetime-timestamptz (#796)"
plan: "origin/dugshub/gaps-batch1-plan:.ai-docs/stacks/gaps-batch1/plan.yaml, key unique-indexes-shapes (Gate 0 approved 2026-10-31 with every open_questions recommendation)"
gate: human
status: implemented (Gate 1 approved 2026-11-03, all recommendations accepted, D1 included)
base: "a8629dfc for this spec. The implementation stacks on #511 (spec: origin/dugshub/511-field-unique-index @ 43ef77c5)."
size: M
related:
  - "#511 (A1: routes field `unique: true` through the builder this PR extends; its spec §8 gives this PR two obligations, met in §5)"
  - "#783 (epic: schema expressiveness)"
  - "#780 (natural keys + upsert: its constraint will go through this builder)"
  - "#786 (CHECK constraints: the expected second reader of the SQL predicate helper)"
  - "#819 (non-unique `indexes:`), #820 (`tenant: false`), #821 (a unique finder must be backed by a constraint)"
  - "#791 (configurable tenancy column; this PR keeps the hard-coded `tenant_id`)"
  - "#696 (the JSON-schema mirror cannot be regenerated)"
  - "#818 (release 0.32.0, which assembles this PR's Changelog block)"
  - docs/adrs/ADR-042-automatic-repository-tenant-scoping.md (§3 the null-tenant partition, §5(c) the tenant prefix)
  - docs/specs/TEN-1.md (§4.4, M5)
---

# Spec: #784, `unique_indexes:` takes `where`, `nulls_not_distinct` and single-field entries

## 1. The gap, measured at `a8629dfc`

- **Schema.** A `unique_indexes:` entry is `{ fields: string[] (min 2), name? }`, `.strict()`
  (`src/schema/entity-definition.schema.ts:1241-1252`). A partial predicate, a NULLS option and a single field are
  all rejected.
- **Emitter.** `processUniqueIndexes` (`templates/entity/new/backend/entity-locals.js:961-981`) always writes
  `uniqueIndex(name).on(...)`, with `tenant_id` prepended under `tenant_scoped`. There is no `where` and no NULLS
  option. The `uniqueIndex` import is keyed on "any entry exists" (`:1948`).
- **The null-tenant hole.** `tenant_id` is nullable by design, and ADR-042 §3 makes the null-tenant partition
  first-class (`tenantPredicateFor`: `null` → `IS NULL`, `runtime/base-classes/scope-filters.ts:84`). Postgres treats
  NULLs in a unique index as distinct, so a tenant-prefixed `uniqueIndex` never deduplicates null-tenant rows.
  The #784 comment reproduced it on PostgreSQL 17: with `CREATE UNIQUE INDEX … (tenant_id, code)`, inserting
  `(NULL, 'a')` twice leaves two rows. Under `UNIQUE NULLS NOT DISTINCT (tenant_id, code)` the second insert fails
  with 23505.
- **Codegen already emits both shapes, by hand.** `unique(...).nullsNotDistinct()` for `external_id_tracking` under
  `tenant_scoped` (`entity-locals.js:1896-1916`), and a partial `uniqueIndex(...).where(sql…)` in the events
  subsystem (`runtime/subsystems/events/domain-events.schema.ts:110-114`). Entity YAML cannot ask for either.
- **The Drizzle limit, checked in drizzle-orm `1.0.0-rc.4`'s type declarations.** `pg-core/indexes.d.ts`:
  `IndexBuilder` has `where(condition: SQL)` and no NULLS option. `pg-core/unique-constraint.d.ts`:
  `UniqueConstraintBuilder` has `nullsNotDistinct()` and no `where`. Postgres 15+ accepts
  `CREATE UNIQUE INDEX … NULLS NOT DISTINCT … WHERE …`, but the builder cannot express it.

## 2. Decisions

**Settled at Gate 0** (plan item `unique-indexes-shapes`, open_questions `where_syntax`, `where_requires_name`,
`tenant_nulls_not_distinct`, `q3_q4_scope`, `finder_unique`):

- The entry is extended. There is no new top-level key. It stays `.strict()`, and `min(2)` becomes `min(1)`.
- `where:` is raw SQL. Unquoted words that name a column of this table are rewritten to `${t.<prop>}`, so
  drizzle-kit quotes them. The rest of the SQL is not validated in batch 1. `drizzle-kit push` in
  `test-integration` is the backstop.
- `name:` is required when `where:` is set.
- `where:` and `nulls_not_distinct: true` are mutually exclusive (the Drizzle limit above).
- On a `tenant_scoped` entity, an entry without `where:` defaults to NULLS NOT DISTINCT. `nulls_not_distinct: false`
  opts out. A partial entry cannot be NND, so it does not deduplicate null-tenant rows. The docs say so, and ADR-042
  gets a dated revision note.
- Out of scope: `tenant: false` (#820), non-unique `indexes:` (#819), and the check that a unique finder is backed by
  a constraint (#821). A `queries:` entry's `unique: true` stays a finder hint.

**Decided in this spec**, where the plan was silent or imprecise. Doug, these are the points to rule on at Gate 1:

- **D1. Field-level uniques take the same tenant default.** #511 lowers a field's `unique: true` into a
  `{ fields: [<col>] }` entry of the list this builder consumes. Under `tenant_scoped` that entry has no `where:`, so
  it becomes `unique(...).on(t.tenantId, t.<col>).nullsNotDistinct()`. #511's spec (§8) reads the approved decision
  the same way. The consequence: a **nullable** `unique: true` field on a tenant-scoped entity admits one NULL per
  tenant, not many, because NND covers every column of the constraint. A field has nowhere to write
  `nulls_not_distinct: false`, so an author who wants "unique when present" moves the declaration to
  `unique_indexes: [{ fields: [<col>], nulls_not_distinct: false }]`. The docs, a unit test and the Changelog state
  this. *Alternative not taken:* key the field-level default on the column's nullability (NND only when the field is
  NOT NULL). That keeps "unique when present" for optional fields, but it gives one declaration two DDL meanings and
  leaves the null-tenant partition open for those fields. Say so at Gate 1 if you want it instead.
- **D2. The `where:` scanner (§4).** It has a small, closed rule set. It rejects `;`, `--`, `/*`, `$`, backtick and
  backslash outside quoted text, and unterminated quotes, because the rewrite cannot be correct across them.
  Unknown identifiers pass through unchecked (Gate 0). **This corrects the plan,** which says the rewrite makes "a
  renamed column fail generation instead of shipping a stale predicate". It does not. A word that names no column
  is copied verbatim, so a stale column name passes generation and fails at `drizzle-kit push`, or at the host's
  schema diff. Only an identifier check would fail generation, and Gate 0 put that out of batch 1.
- **D3. Generation-time checks (§5).** Every `fields:` name must be a column of the table. `tenant_id` may not be
  listed on a tenant-scoped entity, and a field may not repeat within an entry. Names are distinct across the
  extra-config callback. No two non-partial uniques may cover the same column set. The last rule is the
  double-declaration error #511's spec (§8) asks this PR to add.
- **D4. `name:` is a lowercase snake_case identifier of at most 63 characters.** Gate 0 makes `name:` required for
  every partial entry, so author names become common. Today a `'` in a name breaks the emitted TS string literal
  (`uniqueIndex('it's')`), and Postgres silently truncates names longer than 63 characters.
- **D5. Builder imports are derived by use.** Each extra-config entry carries its builder (`index`, `uniqueIndex`
  or `unique`), and the pg-core import list is the set actually used. This replaces three ad-hoc conditions
  (`entity-locals.js:1940-1951` and the `uniqueIndex` that `collectDrizzleImports` adds for `external_id_tracking`
  at `:1011-1016`). Without it, an entity whose uniques are all NND would import an unused `uniqueIndex`. A new
  local, `drizzleOrmImports`, carries `sql` from `drizzle-orm` when a partial entry exists.
- **D6. The predicate helper lives in `templates/_shared/sql-predicate.mjs`.** #786's `checks:` will render raw SQL
  over the same columns, with the same rules.
- **D7. The JSON-schema mirror is updated by hand.** `src/schema/generate-json-schema.ts` still says
  "Columns the composite unique constraint spans (2+)". It cannot run (#696), so its `unique_indexes` entry is
  corrected by hand, as ARCH-1 did for its keys.

## 3. Emitted shapes

### The rule

For each entry, after the Zod shape rules have passed:

```
partial = where is set
nnd     = partial ? false : (nulls_not_distinct ?? tenant_scoped)
cols    = tenant_scoped ? [tenant_id, ...fields] : fields
name    = name ?? `<table>_${cols.join('_')}_uniq`        (unchanged default)

partial → uniqueIndex(name).on(<cols>).where(sql`<rendered where>`)
nnd     → unique(name).on(<cols>).nullsNotDistinct()
else    → uniqueIndex(name).on(<cols>)
```

| Entry | `tenant_scoped: false` | `tenant_scoped: true` |
|---|---|---|
| `{ fields }` (1+ fields) | `uniqueIndex(n).on(cols)` | `unique(n).on(t.tenantId, cols).nullsNotDistinct()` |
| `{ fields, nulls_not_distinct: true }` | `unique(n).on(cols).nullsNotDistinct()` | `unique(n).on(t.tenantId, cols).nullsNotDistinct()` |
| `{ fields, nulls_not_distinct: false }` | `uniqueIndex(n).on(cols)` (the default, stated) | `uniqueIndex(n).on(t.tenantId, cols)` |
| `{ fields, where, name }` | `uniqueIndex(n).on(cols).where(sql…)` | `uniqueIndex(n).on(t.tenantId, cols).where(sql…)` |
| field `unique: true` (#511) | as `{ fields: [col] }` | as `{ fields: [col] }` (D1) |

### Example

```yaml
entity: { name: invoice, plural: invoices, table: invoices, pattern: Base }
tenant_scoped: true
fields:
  customer_id:     { type: uuid, required: true }
  closed_at:       { type: datetime }
  source_event_id: { type: uuid }
  slug:            { type: string, required: true }
  external_code:   { type: string }
behaviors: [timestamps, soft_delete]
unique_indexes:
  - fields: [customer_id]
    where: "closed_at IS NULL"
    name: invoices_one_open_per_customer_uniq
  - fields: [slug]
  - fields: [external_code]
    nulls_not_distinct: false
  - fields: [customer_id, source_event_id]
    nulls_not_distinct: true
```

```ts
import { /* … */ index, pgTable, unique, uniqueIndex, uuid /* … */ } from 'drizzle-orm/pg-core';
import { sql, type InferSelectModel } from 'drizzle-orm';
// …
  (t) => [
    // tenant_scoped behavior (ADR-042) — every scoped read filters on tenant_id
    index('invoices_tenant_id_idx').on(t.tenantId),
    // tenant_scoped — unique per tenant; partial, so NULL-tenant rows never conflict (no NULLS NOT DISTINCT on a partial index in drizzle rc.4)
    uniqueIndex('invoices_one_open_per_customer_uniq').on(t.tenantId, t.customerId).where(sql`${t.closedAt} IS NULL`),
    // tenant_scoped — unique per tenant; NULLS NOT DISTINCT, so the NULL tenant is one partition (ADR-042)
    unique('invoices_tenant_id_slug_uniq').on(t.tenantId, t.slug).nullsNotDistinct(),
    // tenant_scoped — unique per tenant; nulls_not_distinct: false, so NULL-tenant rows never conflict
    uniqueIndex('invoices_tenant_id_external_code_uniq').on(t.tenantId, t.externalCode),
    // tenant_scoped — unique per tenant; NULLS NOT DISTINCT, so the NULL tenant is one partition (ADR-042)
    unique('invoices_tenant_id_customer_id_source_event_id_uniq').on(t.tenantId, t.customerId, t.sourceEventId).nullsNotDistinct(),
  ],
```

The same YAML without `tenant_scoped` emits no comments and no `t.tenantId`. Its `slug` entry becomes
`uniqueIndex('invoices_slug_uniq').on(t.slug)`. The DDL drizzle-kit produces for each builder is the shape the
#784 comment measured with `drizzle-kit export` (rc.4):
`CREATE UNIQUE INDEX "…" ON "…" (…) WHERE "closed_at" IS NULL` for the partial index, and
`CONSTRAINT "…" UNIQUE NULLS NOT DISTINCT(…)` for the constraint.

**Order and comments.** The callback order is unchanged from #511: tenant index, FK indexes, field indexes, field
uniques, `unique_indexes:` entries in YAML order, then the `external_id_tracking` constraint. The comment strings
above are guidance. Tests pin the expressions, not the comments.

**Imports.** `unique` and `uniqueIndex` come into the pg-core import only when an entry uses them (D5).
`import { type InferSelectModel } from 'drizzle-orm';` gains `sql, ` only when a partial entry exists. With no
partial entry, the line is byte-identical to today's.

## 4. The `where:` predicate

`renderSqlPredicate(predicate, columns)` in `templates/_shared/sql-predicate.mjs` returns the body of a
`` sql`…` `` template literal. `columns` maps each column name of the table to its TS property (§5). The scanner
reads the predicate left to right:

| Input, outside quoted text | Output |
|---|---|
| `'…'`, with `''` as an escaped quote inside | copied as-is (a string literal) |
| `"…"`, with `""` inside | copied as-is (a quoted identifier; never rewritten) |
| a number (starts with a digit; digits, letters, `_` and `.` follow) | copied as-is, so the `e5` in `1e5` is not a word |
| a word `[A-Za-z_][A-Za-z0-9_]*` whose lowercase form is a column | `${t.<prop>}`, **unless** the previous token is `.` or `::`, or the next non-blank character is `(`, `.` or `'` |
| any other word, operator or whitespace | copied as-is |
| `;` &nbsp; `--` &nbsp; `/*` &nbsp; `$` &nbsp; `` ` `` &nbsp; `\` | **error** |
| an unterminated `'` or `"` | **error** |

Why each exclusion exists: after `.`, the word is qualified (`x.col`). After `::`, it is a type (`status::text`).
Before `(`, it is a function call (`lower(name)` rewrites `name` and keeps `lower`). Before `.`, it is a qualifier.
Before `'`, it is a typed literal or a string prefix (`date '2024-01-01'`, `E'…'`). Lowercasing follows Postgres,
which folds unquoted identifiers.

Why each error exists: `;` would end the DDL statement. A comment (`--`, `/*`) would swallow whatever drizzle-kit
writes after the predicate. `$` starts dollar quoting or a positional parameter, which the scanner does not model.
Backtick and backslash have no meaning in a standard SQL expression and would need JS escaping. An unterminated
quote leaves the scanner unable to tell literal text from SQL.

**Escaping.** The copied text is escaped for a JS template literal: `\` → `\\`, `` ` `` → `` \` `` and `${` → `\${`.
These are reachable only inside quoted text, since the scanner rejects them outside. Drizzle's `sql` tag reads the
cooked strings (checked: `sql/sql.js` in rc.4 pushes `strings[i]`), so the SQL that reaches drizzle-kit is the
author's text. The rewrite never interpolates a value, only columns. A value would render as a `$1` placeholder,
which is invalid in DDL.

**Known limit.** A word spelled like a column of this table but used as a type or keyword outside the excluded
positions is rewritten. For example, `CAST(x AS date)` breaks on a table with a `date` column. The docs say to write
`x::date`. A column whose name is a reserved word must be double-quoted in the predicate anyway, and quoted
identifiers are copied verbatim.

**Errors** name the entity, the entry and the offending text, for example:
`[codegen] 'invoice' unique_indexes[0] where: ';' at offset 18 is not allowed outside a quoted string. The
predicate is one SQL expression.` The helper throws a plain `Error` carrying the offset, and `entity-locals.js`
prefixes the entity and the entry.

## 5. Generation-time checks

These run in `buildBackendLocals`, not in Zod. The column set depends on the pattern's implied behaviors
(`resolveImpliedBehaviors`: `pattern: Integrated` implies `external_id_tracking`), and the emitter resolves them
while the Zod schema does not. Zod keeps the shape rules (§6), so Studio's write-time validation still reports
those inline. The checks below surface at `entity new`.

**The column map.** `tableColumns` is built from exactly the inputs the entity template renders: `id`; each
`belongsTo[].field` → `camelField`; each rendered non-FK field → `camelName`; `external_id`, `provider` and
`provider_metadata` with `external_id_tracking`; `tenant_id` with `tenant_scoped`; `created_at` and `updated_at`
with `timestamps`; `deleted_at` with `soft_delete`. It is returned as a local (`Array<{ column, prop }>`), and a unit
test pins it to the rendered `pgTable` column block (§8.1), so a column added to the template without the map fails.

| # | Rule | Error names |
|---|---|---|
| C1 | Every `fields:` name is a column in `tableColumns`. Today an unknown name renders `t.<camel>`, which surfaces later as TS2339 in the consumer's entity file. | entity, source, the name, the table's columns |
| C2 | Under `tenant_scoped`, `fields:` does not list `tenant_id` (the builder prefixes it). A name does not repeat within one entry. | entity, source, the name |
| C3 | Every name in the extra-config callback is distinct: the tenant index, FK and field indexes, every unique, and the `external_id_tracking` constraint. | both sources |
| C4 | No two **non-partial** uniques cover the same column set (order-insensitive, after the tenant prefix). This spans field-level uniques (#511), `unique_indexes:` entries and the `external_id_tracking` constraint. Partial entries are exempt: two partial entries over the same columns with different predicates are the documented use (one draft and one published revision per document). | both sources |

Sources are labelled for these messages: `field '<name>' (unique: true)` for #511's lowered entries,
`unique_indexes[<i>]` for YAML entries, and `external_id_tracking` for the synthesized constraint. C4 is #511 §8's
"a field `unique: true` and a `unique_indexes: [{ fields: [<col>] }]` … must be rejected as a double declaration
(I1), naming both".

## 6. Files

| File | Change |
|---|---|
| `src/schema/entity-definition.schema.ts` | The entry becomes `fields: z.array(z.string()).min(1, …)`, `name: z.string().regex(/^[a-z_][a-z0-9_]*$/, …).max(63, …).optional()`, `where: z.string().trim().min(1, …).optional()`, `nulls_not_distinct: z.boolean().optional()`, still `.strict()`, plus a `.superRefine` with the two cross-key rules: `where` with `nulls_not_distinct: true` (issue path `['nulls_not_distinct']`, and the message names the Drizzle limit), and `where` without `name` (issue path `['name']`). Rewrite the block comment at `:1236-1240` to describe the four shapes and the tenant default. |
| `templates/_shared/sql-predicate.mjs` (new) | `renderSqlPredicate` (§4). Dependency-free. It is under `templates/`, which `package.json` `files` already ships, so `files-manifest-coverage.test.ts` needs no change. |
| `templates/entity/new/backend/entity-locals.js` | (a) `entityTableColumns(…)` → the `tableColumns` local (§5). (b) `processUniqueIndexes(entries, { entityName, entityNamePlural, tenantScoped, tableColumns })` applies the §3 rule, renders `where` through `renderSqlPredicate`, runs C1 and C2, and returns `{ name, comment, expr, builder, partial, columns, source }` per entry. (c) #511's `fieldUniqueEntries` entries and the YAML entries carry `source` labels. (d) Every `tableConstraints` entry carries `name` and `builder`; the template reads only `comment` and `expr`. (e) `assertDistinctConstraints(tableConstraints, entityName)` runs C3 and C4 once the list is assembled. (f) The pg-core builder imports are the set of `builder` values in `tableConstraints` (D5). This deletes the `index` condition, the two `uniqueIndex`/`unique` pushes at `:1940-1951` and the `uniqueIndex` in `collectDrizzleImports` at `:1011-1016`. (g) A new local, `drizzleOrmImports`: `['sql']` when any entry is partial, else `[]`. (h) Docblocks for `processUniqueIndexes`, the order comment and the locals-return comment. |
| `templates/entity/new/backend/entity.ejs.t` | `:14` renders each of `drizzleOrmImports` followed by `, ` before `type InferSelectModel`. An empty list gives today's line byte for byte. Update the `:67` comment (`#355/#356` → also `#511/#784`). |
| `src/schema/generate-json-schema.ts` | The mirror's `unique_indexes` entry gets the four keys, with descriptions (D7, #696). |
| `src/__tests__/schema/unique-indexes.test.ts` | Rewrite (§8.1). Delete `'rejects a single-column unique index'`, which asserts the old rule (I7). Update the header. |
| `src/__tests__/templates/sql-predicate.test.ts` (new) | §8.1. |
| `src/__tests__/backend/entity-column-features.test.ts` | New `describe('unique_indexes shapes (#784)')` (§8.1). Update the file header. |
| `src/__tests__/backend/tenant-scoping-templates.test.ts` | The three `unique_indexes` cases at `:135-170` move to the NND default. #511's tenant field-unique cases move to the NND shape. Add the opt-out, partial and D1 cases (§8.1). Update the header (it describes "the per-tenant rewrite of every uniqueness constraint"). |
| `test/smoke/fixtures/account.yaml` | Add `unique_indexes: [{ fields: [name], where: "status <> 'archived'", name: accounts_live_name_uniq }]`: a non-tenant partial over an enum column, beside the `external_id_tracking` `uniqueIndex`. |
| `test/smoke/fixtures/contact.yaml` | Add `unique_indexes: [{ fields: [account_id, email], nulls_not_distinct: true }]`: non-tenant NND over a `belongs_to` FK column, beside the `external_id_tracking` `uniqueIndex`. |
| `test/smoke/fixtures/tenant_note.yaml` | Keep `[title, slug]`, which now takes the NND default. Add `{ fields: [owner_workspace_id], nulls_not_distinct: false }` (a single-field tenant opt-out over a nullable column) and `{ fields: [title], where: "deleted_at IS NULL", name: tenant_notes_live_title_uniq }` (a tenant partial over a behavior column). Update the header list. |
| `test/smoke/run-smoke.ts` | New `assertUniqueIndexShapes(tmpDir)` in the default scenario, before `tsc`, beside #511's `assertFieldUniqueEmission` (§8.2). #511's tenant line moves to the NND shape. |
| `test/scaffold/entities/revision-scaffold.yaml` (new) | Non-tenant `revision`: `document_id` (uuid, required), `version` (integer, nullable: NULL while draft), `status` (string, required). Behaviors `[timestamps]`. Entries: `{ fields: [document_id, version], where: "status = 'published'", name: revisions_published_version_uniq }` and `{ fields: [document_id], where: "status = 'draft'", name: revisions_one_draft_uniq }`, the #784 comment's example. |
| `test/scaffold/entities/category-scaffold.yaml` (new) | `tenant_scoped: true` `category`: `parent_id` (uuid, nullable), `code` (string, required), `slug` (string, required), `external_code` (string, nullable). Behaviors `[timestamps]`. Entries: `{ fields: [parent_id, code], nulls_not_distinct: true }` (explicit), `{ fields: [slug] }` (the default) and `{ fields: [external_code], nulls_not_distinct: false }` (the opt-out). |
| `test/scaffold/schema.ts` | Re-export `@gen/modules/revisions/revision.entity` and `@gen/modules/categories/category.entity` wholesale, as the other generated tables are. |
| `test/scaffold/tests/unique-indexes.test.ts` (new) | §8.3. Gated by `_skip-guard.ts`. |
| `test/scaffold/tests/field-unique.test.ts` (#511's) | Add T3 (§8.3). Update any case that pins `asset_tags_tenant_id_code_uniq` as a plain index: it is now a NULLS NOT DISTINCT constraint, still listed in `pg_indexes` under the same name. |
| `consumer-skills/entities/yaml-reference.md` | A new `## unique_indexes: — unique constraints` section after `relationships:`. It covers the four shapes and the §3 table; that `where:` is raw SQL over snake_case column names, with the §4 rules and the known limit; that `name:` is required with `where:` and, being schema-wide in Postgres, is best prefixed with the table name; the tenant default and its opt-out; the two consequences of NND (a nullable column admits one NULL per key, and a partial entry on a tenant-scoped entity does not deduplicate NULL-tenant rows); and that NULLS NOT DISTINCT needs PostgreSQL 15+. #511's "Uniqueness" note gains one line on D1. |
| `consumer-skills/codegen/SKILL.md` | One gotcha line: uniques on a tenant-scoped entity are NULLS NOT DISTINCT by default (PostgreSQL 15+), and a nullable unique field there admits one NULL per tenant. |
| `.claude/skills/codegen/SKILL.md` | `:236` `unique_indexes: [...]  # composite unique indexes` → `# unique constraints: 1+ fields, where: (partial), nulls_not_distinct:`. |
| `docs/adrs/ADR-042-automatic-repository-tenant-scoping.md` | A dated revision note (the implementing PR's date), after #511's (§6.1). |
| `docs/specs/TEN-1.md` | §4.4, the `unique_indexes:` bullet: a dated note that #784 made tenant-prefixed entries `unique(...).nullsNotDistinct()` by default, with a pointer to ADR-042. M5 becomes "the builder limit, now also behind `unique_indexes:`". |
| `.ai-docs/stacks/gaps-batch1/unique-indexes-shapes.md` | This file, corrected to post-implementation truth in the implementing PR. |

No change to the analyzer, the frontend emitter, Studio, the relations manifest, the junction or relationship
templates, or the repository template. A grep at `a8629dfc` finds no reader of `unique_indexes` outside the files
above.

### 6.1 ADR-042 revision note (text for the implementing PR)

> **Revision note — <date> (#784): tenant-prefixed uniques are NULLS NOT DISTINCT by default.** §5(c) prefixes
> `tenant_id` onto every unique, and TEN-1 emitted the prefixed entries as `uniqueIndex(...)`. Postgres treats NULLs
> in a unique index as distinct, so rows in the null-tenant partition, which §3 makes first-class, never
> conflicted: `(NULL, 'a')` could be inserted twice (reproduced on PostgreSQL 17 in #784). From #784, every
> non-partial unique on a `tenant_scoped` entity is the table constraint
> `unique(...).on(t.tenantId, …).nullsNotDistinct()`. That covers a `unique_indexes:` entry, and a field
> `unique: true`, which #511 routes through the same builder. It is the shape the `external_id_tracking` constraint
> has had since TEN-1. An entry opts out with `nulls_not_distinct: false`. NULLS NOT DISTINCT covers every column of
> the constraint, so a nullable column in it admits one NULL per key. A partial entry (`where:`) cannot be NULLS NOT
> DISTINCT on drizzle-orm 1.0.0-rc.4, so it does not deduplicate null-tenant rows. Requires PostgreSQL 15+.

## 7. Interfaces

- **YAML entry:** `{ fields: string[] (1+), name?: /^[a-z_][a-z0-9_]*$/ (≤63), where?: string (non-empty),
  nulls_not_distinct?: boolean }`, strict. Cross-key rules: `where` → `name` required; `where` with
  `nulls_not_distinct: true` is rejected.
- **`renderSqlPredicate(predicate: string, columns: Map<string, string>): string`** (in
  `templates/_shared/sql-predicate.mjs`). It returns the template-literal body and throws on the §4 errors.
- **`processUniqueIndexes(entries, { entityName, entityNamePlural, tenantScoped, tableColumns })`**, where each
  entry is `{ fields, name?, where?, nulls_not_distinct?, source }`. It returns one
  `{ name, comment, expr, builder: 'unique' | 'uniqueIndex', partial, columns, source }` per entry.
- **New locals:** `tableColumns: Array<{ column: string, prop: string }>` and `drizzleOrmImports: string[]`. The
  template references `drizzleOrmImports` unguarded, so `strict-locals.test.ts` covers it (#638).
- **Changed locals:** `tableConstraints` entries gain `name` and `builder`. `drizzleImports` is derived by use.
- **Emitted Drizzle:** only the three builder chains in §3. No `.unique()` column chain, and no value parameters
  inside `sql`.

## 8. Tests and gates, each shown able to fail on its subject

"Base" means the commit this PR stacks on: #511's head, or `main` once #511 has merged. On that base, the new
fixtures do not parse (`where`, `nulls_not_distinct` and single-field entries are rejected), so every gate that
generates them is red at generation. That is not enough on its own: it shows the YAML is new, not that the
assertions can catch a wrong emission. So each section below also names how its assertions fail on their own
subject.

### 8.1 `just test-unit`

`src/__tests__/schema/unique-indexes.test.ts`:

1. A single-field entry parses.
2. `fields: []` fails at `['unique_indexes', 0, 'fields']`.
3. `{ where, name }` parses, and so does `{ where, name, nulls_not_distinct: false }`.
4. `{ where }` without `name` fails **at `['unique_indexes', 0, 'name']`, with the message**.
5. `{ where, name, nulls_not_distinct: true }` fails **at `['unique_indexes', 0, 'nulls_not_distinct']`, with a
   message containing `rc.4`**.
6. An empty or blank `where`, a non-boolean `nulls_not_distinct`, a `name` with a quote or uppercase, and a 64-char
   `name` each fail.
7. An unknown key fails (kept).

**Red on base:** 1 and 3 fail on `min(2)` and `.strict()`. Cases 4-6 would pass vacuously on base, because base
also rejects them, as unknown keys. That is why they assert the issue **path and message**, which base does not
produce.

`src/__tests__/templates/sql-predicate.test.ts` (new): rewriting of a column; case folding (`Closed_At`); a column
name inside `'…'` stays; `''` inside a literal; a `"quoted"` identifier stays; `lower(name)` → `lower(${t.name})`;
`x::date` and `date '2024-01-01'` are not rewritten on a table with a `date` column; `x.col` is not rewritten;
unknown words (`now`, `TRUE`, `IS`) stay; `1e5` stays; each of the six rejected sequences and both unterminated
quotes throw with an offset; `\`, `` ` `` and `${` inside a literal come out escaped, and evaluating the result as a
template literal gives back the input. **Red on base:** the module does not exist.

`src/__tests__/backend/entity-column-features.test.ts`, `describe('unique_indexes shapes (#784)')`:

1. Single field, non-tenant: `uniqueIndex('messages_conversation_id_uniq').on(t.conversationId)`.
2. Explicit NND, non-tenant: `unique('messages_conversation_id_sequence_uniq').on(t.conversationId, t.sequence).nullsNotDistinct()`.
   `drizzleImports` contains `unique` and not `uniqueIndex` (D5).
3. Partial: `` uniqueIndex('messages_open_uniq').on(t.conversationId).where(sql`${t.status} = 'open'`) ``, and the
   output contains `import { sql, type InferSelectModel } from 'drizzle-orm';`.
4. No partial: the output contains exactly `import { type InferSelectModel } from 'drizzle-orm';`.
5. Rewrite through the column map: a `belongs_to` FK column → `${t.accountId}`; `deleted_at` with `soft_delete` →
   `${t.deletedAt}`; `deleted_at` without `soft_delete` stays `deleted_at`.
6. C1: `fields: [nope]` throws, naming `unique_indexes[0]`, `'nope'` and the columns. C2: a repeated field throws.
7. C3: two entries named alike throw, naming both; an author `name:` equal to a field index's
   `messages_<col>_idx` throws.
8. C4: field `unique: true` plus `unique_indexes: [{ fields: [<same col>] }]` throws, naming
   `field '<col>' (unique: true)` and `unique_indexes[0]`; `[a, b]` plus `[b, a]` throws; two partial entries over the
   same field with different names pass.
9. `tableColumns` pin: for an entity with a `belongs_to`, a field FK, `timestamps`, `soft_delete`,
   `pattern: Integrated` and `tenant_scoped: true`, the `{ column, prop }` set equals the set parsed from the
   rendered `pgTable` column lines (`^    (\w+): \w+\('(\w+)'`).
10. `nulls_not_distinct: false` on a non-tenant entry renders the plain `uniqueIndex`.

`src/__tests__/backend/tenant-scoping-templates.test.ts`:

11. Default: `unique('notes_tenant_id_title_slug_uniq').on(t.tenantId, t.title, t.slug).nullsNotDistinct()`, and no
    `uniqueIndex('notes_tenant_id_title_slug_uniq')`. This replaces the `:135` expectation.
12. An author name is kept: `unique('my_constraint').on(t.tenantId, t.title, t.slug).nullsNotDistinct()` (`:149`).
13. Opt-out: `uniqueIndex('notes_tenant_id_title_slug_uniq').on(t.tenantId, t.title, t.slug)`.
14. Partial: `` uniqueIndex('notes_live_title_uniq').on(t.tenantId, t.title).where(sql`${t.deletedAt} IS NULL`) ``.
15. `tenant_id` in `fields:` throws (C2).
16. #511's tenant field-unique cases emit `unique('notes_tenant_id_title_uniq').on(t.tenantId, t.title).nullsNotDistinct()`.
17. D1: a **nullable** `unique: true` field on a tenant-scoped entity renders the NND constraint. The test name
    says what that means: one NULL per tenant.
18. The non-tenant case (`:161`) is unchanged.

**Red on base:** 1-3, 5-9, 11-17 assert emissions or throws that base does not produce. 4, 10 and 18 are guards
that pass on base and must stay green.

### 8.2 `just test-smoke` (vendored) and `just test-smoke-subsystems` (vendored + package)

`assertUniqueIndexShapes(tmpDir)` runs in the default scenario after `entity new --all` and before `tsc`, with the
same file layout #511's assertion reads (`src/modules/<kebab plural>/<kebab>.entity.ts`):

- `accounts/account.entity.ts` contains
  `` uniqueIndex('accounts_live_name_uniq').on(t.name).where(sql`${t.status} <> 'archived'`) `` and
  `import { sql, type InferSelectModel } from 'drizzle-orm';`;
- `contacts/contact.entity.ts` contains
  `unique('contacts_account_id_email_uniq').on(t.accountId, t.email).nullsNotDistinct()`;
- `tenant-notes/tenant-note.entity.ts` contains
  `unique('tenant_notes_tenant_id_title_slug_uniq').on(t.tenantId, t.title, t.slug).nullsNotDistinct()`,
  `uniqueIndex('tenant_notes_tenant_id_owner_workspace_id_uniq').on(t.tenantId, t.ownerWorkspaceId)` and
  `` uniqueIndex('tenant_notes_live_title_uniq').on(t.tenantId, t.title).where(sql`${t.deletedAt} IS NULL`) ``.

Then `tsc` compiles those files under the consumer's tsconfig. `run-smoke-subsystems.ts` reads the same fixture
directory, so the package-runtime leg compiles them too.

**Failing on its subject.** The content assertions fail on a missing or mis-shaped emission. `tsc` fails on
anything that misuses a builder. Representative mutations, each a one-line change to the generator:
`uniqueIndex(...).nullsNotDistinct()` → TS2339; `unique(...).on(...).where(...)` → TS2339; a missing `sql` import →
TS2304; `${t.deleted_at}` → TS2339. The consumer tsconfig (`bun init`) does not set `noUnusedLocals`, so an
unused import would not fail `tsc`. Import-by-use (D5) is pinned by unit test 2, not by the smoke.

### 8.3 `just test-integration` (Docker, its own CI job)

`test/scaffold/tests/unique-indexes.test.ts` runs against the DDL `drizzle-kit push` builds from the generated
entity files. Rows are inserted with the Drizzle client from `setup.ts`, bypassing the repository (the subject is
the constraint, not scoping), and `truncateAll` runs between tests. A rejection is asserted by SQLSTATE **and** by
constraint name, read as `(err.cause ?? err).code` and `.constraint`, as in #511's suite. The name ties each
rejection to the emitted constraint and not to some other one.

| # | Case | Expect | Fails on its subject when |
|---|---|---|---|
| P1 | two `published` revisions with the same `(document_id, version)` | 2nd: `23505`, `revisions_published_version_uniq` | partial entries are not emitted |
| P2 | the same `(document_id, version)`, once `published` and once `archived` | both succeed | `.where(...)` is dropped (the index becomes total) |
| P3 | two `draft` revisions for one document (`version` NULL) | 2nd: `23505`, `revisions_one_draft_uniq` | partial entries are not emitted |
| P4 | a `draft` and a `published` revision for one document | both succeed | `.where(...)` is dropped |
| N1 | `category` in tenant A, `parent_id` NULL, `code` `'x'`, twice | 2nd: `23505`, `categories_tenant_id_parent_id_code_uniq` | NND is emitted as a plain `uniqueIndex` |
| N2 | as N1 with tenant NULL | 2nd: `23505`, same constraint | as N1 |
| D1 | `slug` `'s'` twice with tenant NULL | 2nd: `23505`, `categories_tenant_id_slug_uniq` | the tenant default is not NND |
| D2 | `slug` `'s'` in tenant A and in tenant B | both succeed | the tenant prefix is dropped |
| O1 | `external_code` `'e'` twice with tenant NULL | both succeed | `nulls_not_distinct: false` is ignored |
| O2 | `external_code` `'e'` twice in tenant A | 2nd: `23505`, `categories_tenant_id_external_code_uniq` | the entry is not emitted |
| O3 | `external_code` NULL twice in tenant A | both succeed | `nulls_not_distinct: false` is ignored |
| K1 | catalog: `pg_get_constraintdef` of `categories_tenant_id_slug_uniq` contains `NULLS NOT DISTINCT`; `categories_tenant_id_external_code_uniq` is in `pg_indexes` and not in `pg_constraint`; the `indexdef` of `revisions_published_version_uniq` contains `WHERE` and `published` | as stated | any builder is swapped |

`test/scaffold/tests/field-unique.test.ts` (#511's), new **T3**: `asset_tag` `code` `'x'` twice with tenant NULL →
2nd: `23505`, `asset_tags_tenant_id_code_uniq`. **This case is red on the base commit, on its subject, with a
fixture that parses there:** on #511's head, a tenant field unique is `uniqueIndex(t.tenantId, t.code)`, so the
second null-tenant insert succeeds. It is the D1 behavior change, and the null-tenant hole the #784 comment
reproduced.

The cases that assert acceptance (P2, P4, D2, O1, O3) pass on any emission that is too weak. The "fails on its
subject when" column names the mutation that makes each one red. The PR records two of these mutation runs: drop
`.where(...)` (P2 and P4 red) and ignore `nulls_not_distinct: false` (O1 and O3 red).

### 8.4 `just test-baseline`, and the other snapshot gates

No baseline fixture declares `unique_indexes:` or `tenant_scoped`. The baseline entities with
`external_id_tracking` are non-tenant and keep `uniqueIndex`, so the import-by-use change (D5) yields the same
import lists. The snapshots must be **byte-identical**. This gate's subject here is "no collateral change": it fails
if `sql` leaks into every `drizzle-orm` import, if the pg-core import order or membership shifts, or if the
callback reorders. It is green on base and must stay green. It is not expected to be red on base.
`just test-junction`, the frontend golden and `test-integration-emit` are untouched, since none of them reads
`unique_indexes`. `just typecheck` covers the new tests.

### Implementer's red-on-base record

In the PR, show §8.1 and §8.2 red with the new tests and fixtures applied over the unchanged generator. Use a
temporary WIP commit, never a bare `git stash`. Then show them green with the fix. For §8.3, record the CI
`test-integration` run, or a local run where Docker is available, including T3 red on base and the two mutation
runs.

## 9. Out of scope, and found while designing

- `tenant: false`, a global unique on a tenant-scoped table: #820. Non-unique `indexes:`: #819. A unique finder
  backed by a constraint: #821.
- `onConflictDoUpdate({ target, targetWhere })` against a partial unique: #780, when an entry becomes an upsert
  target.
- **An identifier check in `where:`** (Gate 0). §2 D2 says what it would buy.
- **Default names longer than 63 characters.** This is a pre-existing property of the default
  `<table>_<cols>_uniq`. D4 bounds only author names.
- **Index names are schema-wide in Postgres, not per table.** Two entities naming a partial entry
  `one_draft_uniq` collide at `drizzle-kit push`. C3 is per entity. The docs advise a table prefix; a whole-set
  check would belong with the other cross-entity emitters.
- **Not taken: a companion index for null-tenant partial entries** (`… WHERE <pred> AND tenant_id IS NULL`
  over the non-tenant columns). It would close the partial-entry hole without NND, but two indexes break
  single-target `ON CONFLICT` inference, which #780 will need.
- **Finding, not fixed here: generated CRUD does not map 23505.** A duplicate surfaces as an unhandled error (a 500)
  rather than a 409. The #784 comment noted it, and no open issue tracks it. Recommend filing it under #783.
- **Finding, not fixed here, likely and still to verify: the `external_id_tracking` constraint under
  `tenant_scoped`.** `unique(tenant_id, provider, external_id).nullsNotDistinct()` covers two nullable columns. A
  row created locally (through POST, where `external_id` and `provider` are behavior-managed and excluded from the
  create DTO) has both NULL. NND makes a second such row in the same tenant a duplicate. This is D1's consequence,
  already shipped by TEN-1. Recommend an issue. A fix would likely make that constraint partial
  (`WHERE external_id IS NOT NULL`), which turns the `integrationUpsert` conflict target into a `targetWhere`.

## 10. Invariants (charter §4)

- **I1 (declare once).** Every constraint derives from the YAML. The column map is derived from the same locals the
  template renders and is pinned to them by a test. Nothing reads generated output back. One builder emits every
  unique, field-level ones included.
- **I7 (no backwards compatibility).** Tenant-scoped uniques change shape with no legacy mode. The
  `'rejects a single-column unique index'` test and the `min(2)` message are deleted, not kept beside the new rule.
- **I9 (honest gates).** Every gate in §8 runs in `just test-all` or in its own CI job (`test-integration`), and §8
  says how each one fails on its subject. Nothing is filtered.
- **I10 (public repository).** Fixtures and docs use neutral names (`invoice`, `revision`, `category`).
- **I11 (scope discipline).** `templates/entity/new/backend/` only, plus the shared helper.

## 11. Changelog block (for the PR body; #818 assembles `[0.32.0]` from it)

```
Changelog:
### Added
- **`unique_indexes:` entries take `where:`, `nulls_not_distinct:` and a single field (#784).**
  `where: "<SQL>"` declares a partial unique index (`uniqueIndex(...).where(sql…)`). The predicate is raw SQL;
  this table's snake_case column names in it are rewritten to Drizzle column references, so drizzle-kit quotes
  them. A partial entry needs `name:`, and cannot also set `nulls_not_distinct: true` (drizzle-orm 1.0.0-rc.4 has
  no NULLS option on a partial index). `nulls_not_distinct: true` emits a `UNIQUE NULLS NOT DISTINCT` table
  constraint (`unique(...).nullsNotDistinct()`). An entry may now list one field.

### Changed
- **On a `tenant_scoped: true` entity, every non-partial unique is NULLS NOT DISTINCT by default (#784).** This
  covers `unique_indexes:` entries and field `unique: true` (#511). Each one was a unique index on
  `(tenant_id, …)` that let rows with a NULL `tenant_id` duplicate each other. It is now the constraint
  `UNIQUE NULLS NOT DISTINCT (tenant_id, …)`, with the same name. Opt out per entry with
  `nulls_not_distinct: false`. NULLS NOT DISTINCT covers every column in the constraint, so a nullable column in
  it admits one NULL per tenant. For "unique when present", declare the column under `unique_indexes:` with
  `nulls_not_distinct: false` instead of `unique: true`. A partial entry on a tenant-scoped entity does not
  deduplicate NULL-tenant rows. NULLS NOT DISTINCT requires PostgreSQL 15 or later.
- `unique_indexes:` `name:` must be a lowercase snake_case identifier of at most 63 characters.
- These are now generation errors: a `fields:` name that is not a column of the table (it used to surface as
  TS2339 in the emitted entity); `tenant_id` listed on a tenant-scoped entity; two non-partial uniques over the same
  columns, including a field `unique: true` repeated as a `unique_indexes:` entry; and two constraints with the
  same name.

**Upgrade:** regenerate (`entity new --all --force`) and review the schema diff. On tenant-scoped tables, each
unique index on `(tenant_id, …)` is replaced by a `UNIQUE NULLS NOT DISTINCT` constraint of the same name. The
migration fails if a table already holds rows the new constraint rejects. Find them first with
`SELECT tenant_id, <cols>, count(*) FROM <table> GROUP BY tenant_id, <cols> HAVING count(*) > 1`.
`GROUP BY` treats NULLs as equal, exactly as NULLS NOT DISTINCT does, so this lists every conflicting group,
including the NULL-tenant ones.
```

## Spec Review

_(Gate 1.5: written by `/critique`.)_

## Design Addendum

_(Filled if Gate 1 or 1.5 changes the design.)_

## Implementation notes

Built as specified; D1-D7 are closed as written. Post-implementation facts:

- **D1** holds: a field `unique: true` on a tenant-scoped entity is `unique(...).nullsNotDistinct()`. Approved at Gate 1.
- **D5** holds. Every `tableConstraints` entry (tenant index, FK and field indexes, uniques, the
  `external_id_tracking` constraint) now carries `name`, `builder` and `source`; the pg-core import list is the set of
  `builder` values. `drizzleOrmImports` and `tableColumns` are new locals.
- **Escaping of quoted text** in `renderSqlPredicate` follows §4: backslash, backtick and `${` inside a quoted literal
  are escaped for the template literal; outside quotes they are errors.
- **Divergences:** none in behavior. `renderSqlPredicate` takes a lowercase-keyed `Map<column, prop>` (the caller
  lowercases column names), and the scanner errors are plain `Error`s whose message `entity-locals.js` prefixes with
  `[codegen] '<entity>' unique_indexes[<i>] where:`.
- **Snapshots:** `just test-baseline` is byte-identical, so no baseline snapshot needed regenerating (no baseline
  entity declares `unique_indexes:` or `tenant_scoped`).
- **Gates run locally:** `just typecheck`, `just test-unit` (4107 pass), `just test-baseline`, `just test-smoke`.
  `test-integration` (the §8.3 cases, T3) is left to the CI `test-integration` job (Docker).

## Diff Review — Adherence

## Diff Review — Quality

## Live Validate
