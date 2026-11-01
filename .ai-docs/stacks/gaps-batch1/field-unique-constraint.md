---
issue: pattern-stack/codegen-patterns#511
github_issue: https://github.com/pattern-stack/codegen-patterns/issues/511
stack: gaps-batch1
stack_position: "A1. field-unique-constraint (#511) → unique-indexes-shapes (#784) → datetime-timestamptz (#796)"
plan: "origin/dugshub/gaps-batch1-plan:.ai-docs/stacks/gaps-batch1/plan.yaml, key field-unique-constraint (Gate 0 approved 2026-10-31 with every open_questions recommendation)"
gate: auto
status: implemented
base: a8629dfc
size: S
related:
  - "#784 (next in Stack A: extends the entry builder this PR routes field uniques through)"
  - "#783 (epic: schema expressiveness)"
  - "#821 (follow-up: a unique finder must be backed by a unique constraint)"
  - "#818 (release 0.32.0, which assembles this PR's Changelog block)"
  - docs/adrs/ADR-042-automatic-repository-tenant-scoping.md (§5(c), revision note 3, follow-up 3)
  - docs/specs/TEN-1.md (§M3, §4.4)
---

# Spec: #511, field `unique: true` emits a unique index (per tenant under `tenant_scoped`)

> **Post-implementation (2026-10-31).** Built as specified. Notes: the 9 new unit tests (cases 1-4, 6-8, plus a
> "keeps an index on a different field" guard) are red on base and green with the fix; case 5 (`id`) is a guard that
> passes on base. The smoke assertion runs under `--scenario default` only (the CRM scenario swaps the fixture set).
> The scaffold test imports the generated tables as camelCase exports (`accountProfiles`, `assetTags`), as the
> other scaffold suites do. The `test-integration` leg (§6.3) needs Docker and is left to CI.

## 1. The defect, measured at `a8629dfc`

A field's `unique: true` reaches the backend locals and is read by nothing. `entity-locals.js` has no reader for
it: `processFieldFeatures` handles `foreign_key` and `index`, `processUniqueIndexes` handles only the top-level
`unique_indexes:` block, and `processBelongsTo` carries a FK field's `index:` but not its `unique:`. So:

- the uniqueness a YAML declares is enforced nowhere, and duplicates land;
- `ON CONFLICT (<col>)` has no arbiter, so a loader cannot upsert on the column (Postgres 42P10);
- `findBy<Field>()` on a `queries: [{ by: [<col>], unique: true }]` finder is typed `T | null` over a column that
  may hold duplicates.

Probe at `a8629dfc` (`buildBackendLocals` over an entity with `label: { unique: true, index: true }` and a
`belongs_to` FK `account_id: { unique: true, index: true }`), `tableConstraints` and `drizzleImports`:

```
tenant=false ["index('seasons_account_id_idx').on(t.accountId)","index('seasons_label_idx').on(t.label)"]  ["index","pgTable","text","uuid"]
tenant=true  ["index('seasons_tenant_id_idx').on(t.tenantId)","index('seasons_account_id_idx').on(t.accountId)","index('seasons_label_idx').on(t.label)"]  ["index","pgTable","text","uuid"]
```

There is no `uniqueIndex` and no `uniqueIndex` import. Without `index: true` the callback is not emitted at all.

The defect is also pinned by a test: `src/__tests__/backend/tenant-scoping-templates.test.ts`
`'emits NO bare single-column unique for a \`unique: true\` field (§M3)'` asserts that nothing is emitted. ADR-042
revision note 3 and follow-up 3 and TEN-1 §M3 / §4.4 record the same absence as "nothing to suppress".

## 2. Decisions

Settled at Gate 0 (plan item `field-unique-constraint`, open_questions `finder_unique`):

- **One builder emits every unique.** A field's `unique: true` is lowered into a single-field entry of the list
  `processUniqueIndexes` already consumes. Under `tenant_scoped: true` that builder prefixes `tenant_id`
  (ADR-042 §5(c)), so a field unique is per tenant without a second code path.
- **A `belongs_to` FK column declared in `fields:` with `unique: true` is covered** (the one-to-one case). The
  lowering reads the raw `fields:` map, which is where `processBelongsTo` already reads that column's `index:`.
- **`queries: [{ by, unique: true }]` stays a finder hint** and emits no DDL. #821 tracks the validation that a
  unique finder is backed by a constraint.
- **The YAML `unique_indexes:` entry keeps `min(2)` here.** #784 lowers it to `min(1)`.
- Default name: `<table>_<col>_uniq`, or `<table>_tenant_id_<col>_uniq` under `tenant_scoped`, which is exactly what
  the existing builder derives for a `{ fields: [<col>] }` entry.

Decided in this spec, where the plan was silent or imprecise:

1. **`unique: true` + `index: true` drops the plain index only on a non-tenant entity.** The plan says the plain
   index is redundant. That holds when the unique index leads with the column. Under `tenant_scoped` the unique
   index is `(tenant_id, <col>)`, which cannot serve a lookup on `<col>` alone: an unscoped `withAllTenants` read,
   or the FK check Postgres runs on a parent `DELETE` against a `belongs_to` column. There the author's
   `index: true` still means something, so both indexes are emitted. The rule is keyed on the one field declaring
   both flags. A composite `unique_indexes:` entry that happens to lead with an indexed column does not suppress
   anything.
2. **`id` is skipped.** `processFields` already skips `id` (the primary key, unique by definition); the lowering
   does the same.
3. **The schema is unchanged.** `unique: z.boolean().optional()` already exists. The `unique_indexes` `min(2)`
   message ("use `unique: true` on the field for single-column uniqueness") becomes true with this fix, so it stays
   as written. The only schema-file edits are comments. `src/__tests__/schema/unique-indexes.test.ts` needs no
   change. (The plan listed both files; neither has a behavior change to make.)
4. **ADR-042 and TEN-1 are corrected in this PR**, not in #784. Their "field `unique: true` emits nothing / nothing
   to suppress" statements stop being true the moment this lands (CLAUDE.md: update the spec/ADR in the same PR).
5. **The integration proof uses two new scaffold entities** rather than adding unique fields to existing ones.
   Existing suites keep their data untouched, and #784's tenant `NULLS NOT DISTINCT` default cannot later collide
   with a nullable column in an existing tenant fixture.
6. **The smoke gets a content assertion.** `tsc` alone passes vacuously on the base commit (nothing is emitted, so
   nothing can fail to compile). See §6.

## 3. Emitted shapes

YAML:

```yaml
entity: { name: season, plural: seasons, table: seasons, pattern: Base }
fields:
  label:      { type: string, required: true, unique: true }
  account_id: { type: uuid,   required: true, unique: true, index: true }
relationships:
  account: { type: belongs_to, target: account, foreign_key: account_id }
```

Non-tenant (`tenant_scoped` absent). The plain `seasons_account_id_idx` is not emitted (decision 1), and `index` is
not imported because no index expression remains:

```ts
import { pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
// …
  (t) => [
    uniqueIndex('seasons_label_uniq').on(t.label),
    uniqueIndex('seasons_account_id_uniq').on(t.accountId),
  ],
```

`tenant_scoped: true`. There is no bare `seasons_label_uniq` or `seasons_account_id_uniq`, and the plain FK index
stays (decision 1):

```ts
  (t) => [
    // tenant_scoped behavior (ADR-042) — every scoped read filters on tenant_id
    index('seasons_tenant_id_idx').on(t.tenantId),
    index('seasons_account_id_idx').on(t.accountId),
    // tenant_scoped — uniqueness is per tenant (ADR-042)
    uniqueIndex('seasons_tenant_id_label_uniq').on(t.tenantId, t.label),
    // tenant_scoped — uniqueness is per tenant (ADR-042)
    uniqueIndex('seasons_tenant_id_account_id_uniq').on(t.tenantId, t.accountId),
  ],
```

DDL (drizzle-kit): `CREATE UNIQUE INDEX "seasons_label_uniq" ON "seasons" USING btree ("label");`. Postgres
accepts a unique index as an `ON CONFLICT (label)` arbiter, and Atlas diffs it as a real constraint.

**Emission order** of the `(t) => [...]` entries: tenant index; `belongs_to` FK indexes; field indexes; **field
uniques, in `fields:` declaration order**; `unique_indexes:` entries in YAML order; the `external_id_tracking`
unique. The order is deterministic, so regenerating gives the same bytes.

**Nullability** is unchanged. A nullable `unique: true` column admits any number of NULLs, which is Postgres' default
(NULLs are distinct). Under `tenant_scoped`, rows with a NULL `tenant_id` do not conflict with each other until #784
makes NULLS NOT DISTINCT the tenant default. The docs say so (§5).

## 4. Files

| File | Change |
|---|---|
| `templates/entity/new/backend/entity-locals.js` | (a) A new module-local helper `fieldUniqueEntries(fields)` returns `{ fields: [<name>] }` for each raw `fields:` entry with `unique === true`, skipping `id`, in declaration order. (b) `buildBackendLocals` passes `[...fieldUniqueEntries(fields), ...(definition.unique_indexes ?? [])]` to the existing `processUniqueIndexes(…, entityNamePlural, tenantScoped)`, whose signature is unchanged. (c) The index rule (decision 1): on a non-tenant entity, the names of fields that declare both `unique: true` and `index: true` form a set. `processFieldFeatures` gains a trailing parameter for that set and skips its `index: true` emission for those names. The `belongsToIndexExpressions` filter skips a `rel.field` in the set. **An absent set means "suppress nothing"**: an extra index is harmless, a silently dropped one is not (CLAUDE.md gate rule (c)). (d) The `index` import is driven by the post-suppression expression lists, which is the existing condition, so the suppressed case imports no unused `index`. The `uniqueIndex` import is driven by `uniqueIndexExpressions.length` (existing). (e) Comments: `processUniqueIndexes`'s docblock (it now emits every unique: field-level and `unique_indexes:`), the `tableConstraints` order comment, the `extraDrizzleImports` comment, the `processBelongsTo` docblock (the FK field's `unique:` is read by the lowering, not carried on the rel), and the locals-return comment. |
| `src/schema/entity-definition.schema.ts` | Comments only. Annotate `unique` in `BaseFieldSchema` (single-column unique index, tenant-prefixed under `tenant_scoped`, #511). The `unique_indexes` block comment notes that field uniques go through the same builder. No Zod change. |
| `src/__tests__/backend/entity-column-features.test.ts` | New `describe('field-level unique (#511)')` (§6.1). |
| `src/__tests__/backend/tenant-scoping-templates.test.ts` | Replace the §M3 test, which asserts the defect, with the tenant cases (§6.1). Update the file docblock (lines 1-10), which describes that negative case. |
| `test/smoke/fixtures/canonical_field.yaml` | `name:` gains `unique: true`: a non-tenant scalar. Header comment notes #511. |
| `test/smoke/fixtures/field_config.yaml` | `field_definition_id:` (a `belongs_to` FK declared in `fields:` with `index: true`) gains `unique: true`: the non-tenant one-to-one case, plus the index-suppression rule. Header comment notes #511. |
| `test/smoke/fixtures/tenant_note.yaml` | `slug:` (already `index: true`) gains `unique: true`: the tenant case, where both indexes are kept. Header list notes #511. |
| `test/smoke/run-smoke.ts` | New `assertFieldUniqueEmission(tmpDir)`, run in the **default** scenario right after `entity new --all` and before `tsc` (§6.2). Uses the existing `assertContains` / `assertNotContains` helpers and reads entity files under `src/modules/…`, the same layout the relationship-scenario helper reads. |
| `test/scaffold/entities/account-profile-scaffold.yaml` (new) | Non-tenant `account_profile`: `account_id` (uuid, required, `unique: true`, `index: true`) with `belongs_to: account`, and `handle` (string, required, `unique: true`). Behaviors `[timestamps]`. |
| `test/scaffold/entities/asset-tag-scaffold.yaml` (new) | `tenant_scoped: true` `asset_tag`: `code` (string, required, `unique: true`, `index: true`). Behaviors `[timestamps]`. |
| `test/scaffold/schema.ts` | Re-export `@gen/modules/account-profiles/account-profile.entity` and `@gen/modules/asset-tags/asset-tag.entity` wholesale, as the other generated tables are, so `drizzle-kit push` creates them. |
| `test/scaffold/tests/field-unique.test.ts` (new) | The DB-level proof (§6.3). Gated by `_skip-guard.ts` like every other suite. |
| `consumer-skills/entities/yaml-reference.md` | `fields:` block: add `unique: true  # unique index; per tenant under tenant_scoped`. Add a short "Uniqueness" note after the nullability table covering field `unique:`, the tenant prefix, `unique: true` + `index: true` (decision 1), NULLs, and "a `queries:` `unique: true` is a finder hint and emits no DDL". |
| `consumer-skills/entities/families-and-queries.md` | Line 53 currently says a query's `unique: true` "marks the underlying index unique". That is false. Replace it with: returns a single row or null; a finder hint that emits no DDL; declare the constraint with field `unique: true` or `unique_indexes:`. |
| `consumer-skills/codegen/SKILL.md` | Line 213: replace the "creates an index, not a DB `UNIQUE` constraint" gotcha with the true statement (field `unique: true` emits a unique index, per tenant under `tenant_scoped`; a query's `unique: true` is a hint). |
| `.claude/skills/codegen/SKILL.md` | Line 229, the `# NOTE: emits an index, not a DB UNIQUE constraint` comment on the query: replace it with "finder hint (single row); no DDL. The constraint is field `unique: true` / `unique_indexes:`". Add `unique: true` to the `fields:` example's `email` line. |
| `docs/adrs/ADR-042-automatic-repository-tenant-scoping.md` | A dated revision note (the implementing PR's date) after the 2026-09-20 note. Since #511, field `unique: true` emits a single-column unique index through the same builder as `unique_indexes:`, so §5(c)'s tenant prefix applies to it and no bare unique is emitted under `tenant_scoped`. This supersedes revision note 3 and follow-up 3 ("There is nothing to suppress"). `queries: { unique: true }` remains a finder hint with no DDL, unlike §5(c)'s original text (#821). Follow-up 3 gets a one-line pointer to the note. |
| `docs/specs/TEN-1.md` | §M3 and §4.4's first bullet: a dated note that #511 made field `unique: true` emit, tenant-prefixed by `processUniqueIndexes`. The §test-table row for `tenant-scoping-templates.test.ts` (line ~737) reads "field `unique: true` emits only the tenant-prefixed unique" instead of "no bare single-column unique (§M3)". |

`templates/entity/new/backend/entity.ejs.t` needs no change. It renders `tableConstraints` and `drizzleImports`
generically. It may optionally update its `#355/#356` comment to mention #511.

No change to the analyzer, the frontend emitter, Studio or the relations manifest: none of them reads field
`unique:` for emission (checked with a grep of `src/emitters`, `src/inspector` and `src/studio/server` at `a8629dfc`).

## 5. Interfaces

- `processUniqueIndexes(uniqueIndexes, entityNamePlural, tenantScoped)`: unchanged signature. Its input is now
  "every unique this entity declares", field-level first.
- `processFieldFeatures(renderedFields, fields, naming, ownedTables, uniqueLedIndexNames?)`: the new trailing
  parameter is a `Set<string>` of field names whose `index: true` is suppressed. Absent or empty means no
  suppression.
- `buildBackendLocals`: no new or removed locals. `tableConstraints` and `drizzleImports` carry the new entries.
  `assertNoUndefinedLocals` is unaffected.
- Emitted Drizzle: `uniqueIndex('<name>').on(t.<camel>[, …])`, built only from builders the entity file already
  imports elsewhere. No `.unique()` column chain is introduced; one builder means one shape.

## 6. Tests and gates, each shown red on the base commit

### 6.1 `just test-unit`

`entity-column-features.test.ts`, new `describe('field-level unique (#511)')`:

1. A scalar `unique: true` emits `uniqueIndex('<t>_<col>_uniq').on(t.<camel>)`, `drizzleImports` contains
   `uniqueIndex`, and the column chain has no `.unique()`.
2. A `belongs_to` FK declared in `fields:` with `unique: true` emits `uniqueIndex('<t>_account_id_uniq').on(t.accountId)`.
3. `unique: true` + `index: true` on a non-tenant scalar emits no `<t>_<col>_idx`. On a non-tenant FK it emits no
   `<t>_account_id_idx`. When that was the only index, `drizzleImports` does not contain `index`.
4. Field uniques precede `unique_indexes:` entries, in `fields:` order, inside one `(t) => [` callback.
5. An `id: { unique: true }` declaration emits nothing extra.

`tenant-scoping-templates.test.ts`, replacing the §M3 test:

6. A tenant-scoped `unique: true` field emits `uniqueIndex('notes_tenant_id_title_uniq').on(t.tenantId, t.title)`
   and does **not** contain `uniqueIndex('notes_title_uniq')` or `.unique()`. The no-bare-unique assertion is kept;
   it is the ADR-042 property.
7. Tenant-scoped `unique: true` + `index: true` emits both `index('notes_title_idx')` and the tenant unique
   (decision 1).
8. A tenant-scoped `belongs_to` FK with `unique: true` emits `(t.tenantId, t.<fk>)`.

**Red on base:** 1-4 and 6-8 assert a `uniqueIndex` the base never emits (probe in §1), and 3 also asserts the
absence of an `_idx` the base does emit. 5 is a guard and passes on base.

### 6.2 `just test-smoke` (vendored) and `just test-smoke-subsystems` (vendored + package)

`assertFieldUniqueEmission` (default scenario, before `tsc`):

- `canonical-fields/canonical-field.entity.ts` contains `uniqueIndex('canonical_fields_name_uniq').on(t.name)`;
- `field-configs/field-config.entity.ts` contains
  `uniqueIndex('field_configs_field_definition_id_uniq').on(t.fieldDefinitionId)` and does not contain
  `index('field_configs_field_definition_id_idx')`;
- `tenant-notes/tenant-note.entity.ts` contains `uniqueIndex('tenant_notes_tenant_id_slug_uniq').on(t.tenantId, t.slug)`
  and `index('tenant_notes_slug_idx')`, and does not contain `uniqueIndex('tenant_notes_slug_uniq')`.

Then the existing `tsc` step compiles those files under the consumer tsconfig. `run-smoke-subsystems.ts` reads the
same fixture directory, so the package-runtime leg compiles them too.

**Red on base:** the content assertion fails on the first file, because the base emits no `uniqueIndex`. Without it,
this gate could not fail on its subject: on base there is no emission for `tsc` to reject (CLAUDE.md, "a gate must
be able to fail on its own subject"). With it, a wrong builder or a mis-cased `t.<col>` fails `tsc`, and a missing
or mis-shaped emission fails the assertion.

### 6.3 `just test-integration` (Docker; its own CI job)

`test/scaffold/tests/field-unique.test.ts`, against the DDL `drizzle-kit push` creates from the generated entity
files. Rows are inserted with the Drizzle client from `setup.ts` and `truncateAll` runs between tests. SQLSTATE is
read from the driver error (`(err.cause ?? err).code`, since Drizzle 1.0 wraps query errors), and so is the violated
index name (`.constraint`). Asserting the name ties each rejection to the emitted index, not to the PK or some other
constraint.

| # | Case | Expect | Base |
|---|---|---|---|
| U1 | Two `account_profiles` with the same `handle` (different accounts) | second insert: `23505`, constraint `account_profiles_handle_uniq` | **red**: the insert succeeds |
| U2 | Two `account_profiles` for one account | `23505`, constraint `account_profiles_account_id_uniq` | **red** |
| U3 | `insert … onConflictDoNothing({ target: accountProfiles.handle })` over an existing handle | no error; one row | **red**: `42P10`, no arbiter |
| U4 | `pg_indexes` for both tables | `account_profiles_{handle,account_id}_uniq` present and unique; `account_profiles_account_id_idx` absent; `asset_tags_tenant_id_code_uniq` present on `(tenant_id, code)`; `asset_tags_code_idx` present; `asset_tags_code_uniq` absent | **red** |
| T1 | The same `code` in tenant A and in tenant B | both inserts succeed | green on base, by design: it guards against a bare global unique, and goes red if the tenant prefix is dropped |
| T2 | The same `code` twice in tenant A | `23505`, constraint `asset_tags_tenant_id_code_uniq` | **red** |

### 6.4 `just test-baseline`

No baseline fixture declares a field `unique: true`. At `a8629dfc` the only `unique: true` in
`test/fixtures/entities/` is `contact-v2.yaml`'s query hint, so the snapshots are **byte-identical**. This gate's
subject here is "no collateral change": it fails on any byte change to an entity that declares no field unique,
for example if the lowering misfires on every field or reorders existing constraints. It is green on base and must
stay green. It is not expected to be red on base. The junction, frontend-golden and integration-emit snapshots are
untouched for the same reason (`test/frontend-golden/entities/user.yaml` declares a field `unique: true`, but that
gate compares only the frontend tree, which does not read `unique:`).

### Implementer's red-on-base record

In the PR, show 6.1 and 6.2 red with the new tests and fixtures applied over the unchanged generator (a temporary
WIP commit; never a bare `git stash`). Then show them green with the fix. For 6.3, record the CI `test-integration`
run, or a local run where Docker is available.

## 7. Out of scope

- `unique_indexes:` shapes (`where`, `nulls_not_distinct`, single-field entries) and the tenant NND default: #784.
- `queries: { unique: true }` emitting or checking DDL: #821.
- `tenant: false` (a global unique on a tenant-scoped table): #820. Non-unique `indexes:`: #819.
- **Junction and relationship payload fields** (`junctions/*.yaml` / `relationships/*.yaml` `fields:`). Their
  schemas take `z.record(z.string(), z.any())` and their templates read neither `index:` nor `unique:`. That is the
  same gap on another pipeline, and it is not in this batch. Flagged for a follow-up under #783.
- Index names longer than Postgres' 63-character limit. This is a pre-existing property of the shared builder's
  default name, and it is unchanged here.

## 8. What downstream must know

- **#784:** field uniques arrive in `processUniqueIndexes` as plain `{ fields: [<col>] }` entries, ahead of YAML
  entries. They carry no `where:`, so #784's tenant default (NULLS NOT DISTINCT, `unique(...).nullsNotDistinct()`)
  applies to them too, which is the approved decision. Once #784 admits single-field YAML entries, a field
  `unique: true` and a `unique_indexes: [{ fields: [<col>] }]` produce two entries with the same default name.
  #784 must reject that as a double declaration (I1), naming both. The index-suppression set (decision 1) is keyed
  on field flags only, so it is unaffected by #784's entry shapes. A partial unique must never suppress a plain
  index.
- **#796:** no interaction.
- **#818 (release):** this PR's Changelog block is below.

## 9. Invariants (charter §4)

- **I1:** the YAML flag is the single declaration, and field and composite uniques share one builder. No second
  emission path, no introspection of generated output.
- **I7:** no opt-out flag and no "legacy plain index" mode. Every existing `unique: true` field gains its unique
  index on regeneration, and the Changelog says how to migrate.
- **I9:** every gate in §6 is in `just test-all` or its own CI job, and §6 says how each fails on its subject.
- **I10:** fixtures and docs use neutral domain names (`season`, `account_profile`, `asset_tag`).
- **I11:** `templates/entity/new/backend/` only.

## 10. Changelog block (for the PR body; #818 assembles `[0.32.0]` from it)

```
Changelog:
### Fixed
- **A field's `unique: true` now emits a unique index (#511).** It used to emit nothing, so declared
  uniqueness was enforced nowhere and `ON CONFLICT (<col>)` had no arbiter. `unique: true` on a field now
  emits `uniqueIndex('<table>_<col>_uniq').on(t.<col>)`. Under `tenant_scoped: true` the index is per tenant:
  `uniqueIndex('<table>_tenant_id_<col>_uniq').on(t.tenantId, t.<col>)` (ADR-042 §5(c)). This includes a
  `belongs_to` FK column declared in `fields:` with `unique: true` (a one-to-one). On a non-tenant entity, a
  field with both `unique: true` and `index: true` now gets only the unique index. A `queries:` entry's
  `unique: true` is unchanged: it shapes the finder's return type and emits no DDL.
  **Upgrade:** regenerate (`entity new --all --force`) and review the schema diff. Every existing
  `unique: true` field gains a `CREATE UNIQUE INDEX`. On a non-tenant entity that also set `index: true`, the
  old `<table>_<col>_idx` is dropped. The migration fails if the table already holds duplicates, so remove
  them first. Find them with
  `SELECT <col>, count(*) FROM <table> GROUP BY <col> HAVING count(*) > 1`
  (on a tenant-scoped table, group by `tenant_id, <col>`).
```
