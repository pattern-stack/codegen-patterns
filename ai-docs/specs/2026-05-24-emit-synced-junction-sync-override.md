# Emit the Synced/Junction sync-override (codegen-patterns implementation spec)

**Issue:** #374 · **Rides on:** PR #373 (`@generated` banner), #372 (junction role-inclusive PK)
**Contract spec (the WHAT):** `dealbrain-integrations/.ai-docs/specs/a2-codegen-sync-override.md`
**This doc (the HOW):** resolves the 5 implementation decisions the contract spec left open.
**Author:** Dug + Claude · **Date:** 2026-05-24

---

## Goal

Lift the ~230-line hand-written inbound-sync write surface (currently duplicated across 5 `force:true` generated repos in dealbrain-integrations and silently wiped on every `codegen entity new --all`) into codegen. Generic logic lands in the runtime base classes; per-entity `syncConfig` literals + `TSyncWrite`/`TSyncProjection` types are emitted by the templates — same idiom as `behaviors` / `patternConfig`.

## Context

### Current state
- `runtime/base-classes/synced-entity-repository.ts:46` — `syncUpsert` is a throwing stub. `SyncedEntityRepository<TEntity>` is single-param, extends `BaseRepository<TEntity>` (`runtime/base-classes/base-repository.ts`).
- `BaseRepository` provides `runner(tx)` (`:75`), `baseQuery()` (`:230`), `withTimestamps()` (`:245`), `protected readonly db`, `protected abstract readonly table`.
- Junction repos extend `BaseRepository` directly (`templates/junction/new/repository.ejs.t`) — no sync surface today.
- As of #372, role-bearing junction PKs span `(leftId, rightId, role)` — a real ON CONFLICT target (`templates/junction/new/entity.ejs.t:89-94`). Role-less junctions keep `(leftId, rightId)`.

### Template scope already available (no new derivation needed)
**Entity (clean-lite-ps), `prompt-extension.js`:**
- `clpBelongsTo[]` — `{ field, camelField, relatedEntity, relatedEntityPascal, relatedTable (plural var), nullable, importPath: '../<plural>/<target>.entity', relationKey, isSelfFk, onDelete }`. **FK columns are split OUT of `clpProcessedFields` into here.**
- `clpProcessedFields` (= non-FK fields) — each `{ name, camelName, type, tsType, nullable, required, hasChoices, choices, ... }`.
- `hasExternalIdTracking`, `hasSoftDelete`, `hasTimestamps`, `hasUserTracking`, `eavEnabled`, `patternName`, `classNames`, `renderPatternConfigLiteral`.

**Junction, `prompt.js`:**
- `leftEntity/rightEntity` (+ `…Pascal`, `…Plural`, `…Camel`), `leftColumn/rightColumn` (+ `…Camel`), `leftTable/rightTable` (parent table var names), `hasRole`, `roleEnumName`, `leftEntityImportFromJunction`/`rightEntityImportFromJunction` (`../<plural>/<entity>.entity`), `classNames`.

### Reference (the wiped hand-impl — read as spec-by-example, but see Decision 3)
- Entity: `dealbrain-integrations/src/modules/accounts/account.repository.ts`
- Junction: `dealbrain-integrations/src/modules/account_contacts/account_contact.repository.ts`
- Sinks (the consumer contract the signatures must satisfy): `dealbrain-integrations/src/modules/crm_sync/sinks/*.sink.ts`

### Invariants to preserve (do NOT lose on the lift)
Opportunistic-FK-null **+ no-clobber-with-null** in the conflict `set` (entity); strict-throw on unresolved FK (junction); provider scoping on **every** external-id lookup; self-FK as `refTable: 'self'`; tombstone-by-clearing when `soft_delete: false`; projection omits `provider`/`provider_metadata` (keeps `externalId`); batch `syncUpsert` reads `provider` per-input and skips incomplete rows.

---

## The 5 design decisions

### Decision 1 — `SyncUpsertConfig` shape (full, incl. write columns)

The contract spec's `SyncConfig` lacked a write-column list. The generic upsert separates three column roles: **identity** (conflict target, only in `values`), **copy-through** (`values` + `set`), **resolved FK** (conditional in `set`). New type (named `SyncUpsertConfig` to avoid collision with the sync subsystem's `DetectionConfig`):

```ts
// runtime/base-classes/sync-upsert-config.ts
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';

export interface SyncFkResolver {
  column: string;        // local FK column (camel key into this.table), e.g. 'parentAccountId'
  writeKey: string;      // key on TSyncWrite carrying the parent external id (see Decision 4)
  refTable: PgTableWithColumns<any> | 'self';  // 'self' → this.table
  strict?: boolean;      // true = throw on unresolved (junction); falsy = opportunistic null (entity)
}

export interface SyncUpsertConfig {
  conflictTarget: string[];   // camel keys into this.table, e.g. ['provider', 'externalId']
  writeColumns: string[];     // canonical cols copied verbatim write→values/set (camel). EXCLUDES
                              // externalId, provider, FK columns, and behavior-managed timestamps.
  fkResolvers: SyncFkResolver[];
  projectionColumns: string[];// cols picked into the projection (camel), incl. id/externalId/timestamps
  eav: boolean;
  softDelete: boolean;
}
```

Generic upsert assembly in the base:
- `values = { externalId: write.externalId, provider, ...pick(write, writeColumns), ...resolvedFks, ...(timestamps ? { updatedAt: now } : {}) }`
- `set    = { ...pick(write, writeColumns), ...conditionalResolvedFks, ...(timestamps ? { updatedAt: now } : {}) }` — `externalId`/`provider` never in `set` (they're the identity); each resolved FK included **only when non-null this run** (no-clobber).

### Decision 2 — FK resolvers carry live Drizzle table handles (not strings)

`renderPatternConfigLiteral` quotes strings, so it **cannot** emit a live table identifier. Therefore the `syncConfig` literal is **hand-emitted by the template** (not routed through `renderPatternConfigLiteral`), with `refTable` as either the string `'self'` or the imported parent-table const:

```ts
fkResolvers: [
  { column: 'parentAccountId', writeKey: 'parentExternalId', refTable: 'self' },
  // non-self synced FK:
  { column: 'accountId', writeKey: 'accountExternalId', refTable: accounts },
],
```

The base resolves `refTable === 'self' ? this.table : refTable`, then `SELECT id WHERE (provider, externalId) = (provider, write[writeKey])`. Non-self FK parent tables are imported into the repo file from `clpBelongsTo[].importPath` (`../<plural>/<target>.entity`). **#368 watch:** dedupe parent-table imports against the entity's own import and each other (template-level `Set` of already-imported modules) — the multi-junction import-dedup bug lived exactly here.

> Note: `account` only has a self-FK, so the DBI oracle does **not** exercise the non-self synced-FK import path. Cover it with a codegen unit test (a synced entity with a `belongs_to` a *different* synced entity).

### Decision 3 — Junction base uses `onConflictDoUpdate` on the `(left,right,role)` PK (supersedes the stale reference)

The DBI junction reference (`account_contact.repository.ts:117-128`) used SELECT-then-INSERT/UPDATE **because the role-inclusive constraint didn't exist when it was written**. Post-#372 it does. The lift emits the **better** version:

```ts
await db.insert(this.table)
  .values({ [leftCol]: leftId, [rightCol]: rightId, ...(roleColumn ? { [roleColumn]: write.role } : {}), updatedAt: now })
  .onConflictDoUpdate({
    target: roleColumn ? [this.table[leftCol], this.table[rightCol], this.table[roleColumn]]
                       : [this.table[leftCol], this.table[rightCol]],
    set: { updatedAt: now },
  })
  .returning();
```

New base `JunctionSyncRepository<TEntity, TSyncWrite, TSyncProjection>` (`runtime/base-classes/junction-sync-repository.ts`) extends `BaseRepository<TEntity>`. Config:

```ts
export interface JunctionSyncConfig {
  left:  { column: string; refTable: PgTableWithColumns<any> };  // strict
  right: { column: string; refTable: PgTableWithColumns<any> };  // strict
  roleColumn: string | null;   // null → role-less junction (2-part composite, 2-col conflict)
}
```

Both FK resolutions are **strict** (throw on unresolved → orchestrator records a failed item and continues). Composite externalId build/parse are **static helpers in the base file** (`buildCompositeExternalId` / `parseCompositeExternalId`, `::` delimiter, 3 parts when role else 2), replacing the per-repo free functions in the reference. `findByExternalIdProjected` / `softDeleteByExternalId` parse the composite, resolve both parents **non-throwing** (→ `null`), then select/delete by tuple. Junction projection `id` is the synthesized composite string (no surrogate id column).

### Decision 4 — `TSyncWrite` / `TSyncProjection` emission + FK-key naming

Emitted per entity, gated on `pattern === 'Synced'`. Field TS types come from `clpProcessedFields[].tsType` (already maps YAML type → TS, narrows enums to literal unions) with `| null` appended when `nullable`.

- **`TSyncWrite`** = `externalId: string` + `pick(clpProcessedFields, writeColumns)` (typed, nullable-aware) + one `<writeKey>?: string | null` per `clpBelongsTo` FK + `fields?: Record<string, unknown>`. Excludes `id`, timestamps, `provider`, `providerMetadata`, and the resolved local FK columns.
- **`TSyncProjection`** = `id` + `externalId` + `pick(clpProcessedFields)` + each FK local column + `createdAt`/`updatedAt`. Omits `provider`/`providerMetadata`.

**FK-key naming (RESOLVED — Open Question 1, option a):** `writeKey = ${relationKey}ExternalId` (e.g. `parentAccount` → `parentAccountExternalId`). Deterministic, no new YAML surface. The DBI account sink renames its one write-key `parentExternalId → parentAccountExternalId` (sink is consumer-owned glue, not one of the 5 generated repos; method signatures unchanged, only the field name moves). Junction FK keys use `${camelCase(entity)}ExternalId` (e.g. `accountExternalId`) — already matches the reference.

### Decision 5 — EAV seam: overridable no-op hook, config-gated (live path lands in #124)

**No sink passes a `fields` bag today**, so the DBI oracle does not exercise the live EAV write — it activates downstream in #124. Emit the seam as an overridable hook on the base, default no-op:

```ts
protected async writeCustomFields(_db: DrizzleTx, _entityId: string, _userId: string, _fields: Record<string, unknown>): Promise<void> {}
```

`syncUpsertOne` calls it inside the tx only when `syncConfig.eav && write.fields` non-empty. When `eav: true`, the template emits a concrete override that injects `FieldValueService` and delegates to `upsertFieldsTransactional(entityType, entityId, userId, fields, db)` — aligning with the use-case path (`templates/entity/new/clean-lite-ps/use-cases/create.ejs.t:52`) and the downstream #126 batch projector contract (shared `FieldValueService` write; no duplicate key→def resolution). Repo→`FieldValueService` injection is an eav-gated exception to the layer rules, isolated to eav repos only — base stays portable (core/extension principle).

---

## Plan

### Step 1 — `SyncUpsertConfig` type
- File: `runtime/base-classes/sync-upsert-config.ts` (new)
- Add `SyncUpsertConfig` + `SyncFkResolver` (Decision 1). Export from `runtime/base-classes/index.ts` if a barrel exists.

### Step 2 — Implement generic logic in `SyncedEntityRepository`
- File: `runtime/base-classes/synced-entity-repository.ts`
- Widen to `SyncedEntityRepository<TEntity, TSyncWrite = Partial<TEntity>, TSyncProjection = TEntity>` (defaults keep existing single-param subclasses compiling).
- Add `protected abstract readonly syncConfig: SyncUpsertConfig`.
- Implement `syncUpsertOne(write, provider, tx)`, `findByExternalIdProjected(externalId, provider)`, `softDeleteByExternalId(externalId, provider, tx)`, `toProjection(row)` (generic pick over `projectionColumns`), `writeCustomFields` (no-op hook), and **concretize** `syncUpsert(inputs)` (batch wrapper, per-input provider, skip incomplete). Replace the stub at `:46`.
- Preserve every invariant from Context (opportunistic null, no-clobber, provider scoping, tombstone-by-clearing vs `deletedAt`, projection omit).

### Step 3 — New `JunctionSyncRepository` base
- File: `runtime/base-classes/junction-sync-repository.ts` (new)
- Decision 3: `JunctionSyncConfig`, generic methods using `onConflictDoUpdate`, strict dual-FK resolution, static composite build/parse helpers, role/role-less branch.

### Step 4 — Entity template emission
- File: `templates/entity/new/clean-lite-ps/repository.ejs.t`
- Gate on `patternName === 'Synced'`: emit `TSyncWrite`/`TSyncProjection` interfaces, the hand-emitted `syncConfig` literal (Decision 2 — live `refTable` handles, deduped parent-table imports), widen the `extends` to `SyncedEntityRepository<Entity, EntitySyncWrite, EntitySyncProjection>`, and (when `eavEnabled`) emit the `writeCustomFields` override + `FieldValueService` injection.
- Derive `writeColumns`/`projectionColumns`/`fkResolvers` in the template (or, cleaner, pre-compute in `prompt-extension.js` `buildCleanLitePsLocals` as `clpSyncConfig` + `clpSyncWriteFields`/`clpSyncProjectionFields` and emit from there — **preferred**, keeps EJS thin and unit-testable).

### Step 5 — Junction template emission
- File: `templates/junction/new/repository.ejs.t`
- Emit junction `TSyncWrite`/`TSyncProjection`, the `JunctionSyncConfig` literal (live `leftTable`/`rightTable` handles + parent imports), `extends JunctionSyncRepository<…>`. Keep the existing two pairing-finders. Role/role-less branch on `hasRole`.

### Step 6 — Pattern library
- File: `src/patterns/library/synced.pattern.ts`
- Update `repositoryInheritedMethods` to list the now-real `syncUpsertOne`, `findByExternalIdProjected`, `softDeleteByExternalId` (+ keep `syncUpsert`). Update the inherited-method comment lines the template prints.

### Step 7 — Tests
- Base unit tests (Memory/pg-lite or table mock): FK resolution (opportunistic-null + no-clobber), provider scoping, `findByExternalIdProjected`, `softDeleteByExternalId` (both `softDelete` branches), batch `syncUpsert`. Junction: strict dual-FK resolution + composite build/parse + role-less variant.
- Template-emission tests: `pattern: Synced` emits config + types + `@generated` banner; non-self synced-FK import path; junction variant; eav override path; no hand-method expectation remains.
- Update baseline snapshots (`test/baseline/`) for synced fixtures — diff should be exactly the new sync surface.

---

## Acceptance Criteria

**codegen-patterns:**
- [x] `SyncedEntityRepository.syncUpsert` stub replaced; all 5 methods + config implemented and unit-tested (both `softDelete` branches, opportunistic-null, no-clobber, provider scoping, batch).
- [x] `JunctionSyncRepository` implemented with `onConflictDoUpdate` on the role-inclusive PK; role + role-less covered.
- [x] Templates emit `syncConfig` + `TSyncWrite`/`TSyncProjection` (entity + junction); parent-table imports deduped (#368). *(`@generated` banner deferred to PR #373 — not on this branch; see Implementation notes.)*
- [x] `synced.pattern.ts` inherited-method list updated.
- [x] `bun run build` + suite green; junction snapshots regenerated (clean baseline unaffected — see Implementation notes). *(Pristine `main` carries 3 pre-existing `junction.ts`/`barrel-generator.ts` typecheck errors + 1 smoke-junction regex failure — unrelated; not masked, not fixed here.)*

**DBI validation oracle (the unambiguous "done", owned by dealbrain-integrations):**
- [ ] Point DBI at `file:/Users/dug/Projects/codegen-patterns` → `bun install` → `bun run codegen`.
- [ ] `git diff` on the 5 repos (`accounts`, `contacts`, `opportunities`, `account_contacts`, `opportunity_contacts`) shows **only generated content** — no hand glue to lose.
- [ ] `bun run typecheck` → **0 errors** (sinks resolve against generated/inherited methods). *(Gated on Open Question 1 — sinks may need the `parentExternalId → parentAccountExternalId` rename.)*
- [ ] Full DBI unit suite green (**699** at last green).
- [ ] Publish a `@pattern-stack/codegen` bump; DBI consumes; #124 re-emit lands clean.

---

## Open Questions

1. **✅ RESOLVED — FK-external-id write-key naming.** Option (a): emit `writeKey = ${relationKey}ExternalId` (→ `parentAccountExternalId`); DBI sink renames its one write-key `parentExternalId → parentAccountExternalId`. The contract-spec §6 "signatures unchanged" clause governs *method* signatures (unchanged); only the write *field* name moves. **Action carried into the DBI side of the oracle:** the typecheck-0 step includes the sink rename.
2. **✅ RESOLVED — syncConfig in `prompt-extension.js` vs inline EJS.** Pre-computed in JS: `buildSyncSurface(...)` in `prompt-extension.js` returns `clpSyncConfig` + `clpSyncFkResolvers` + `clpSyncWriteFields`/`clpSyncWriteFkFields` + `clpSyncProjectionFields` + `clpSyncParentTableImports` (+ `hasSyncSurface`). The junction side computes the equivalents in `templates/junction/new/prompt.js` (`junctionSyncConfig`, `syncWriteFields`, `syncProjectionFields`, `syncParentImports`, `leftSyncWriteKey`/`rightSyncWriteKey`, `roleColumnCamel`/`roleTsType`). EJS stays thin: it only hand-emits the literal (so `refTable` is a live identifier) and the interfaces. `buildSyncSurface` is exported for unit tests.
3. **✅ RESOLVED — Type-param defaults vs abstract `syncConfig`.** `syncConfig` is abstract. One non-generated synced repo exists: the hand-written `TestCrmRepository` in `test/scaffold/tests/synced-entity-repository.test.ts` — given a minimal hand-written `syncConfig` in this PR. Its `syncUpsert throws not implemented` assertion was replaced (the method is now concrete; empty input → `[]`).
4. **✅ RESOLVED — Junction `userId`.** Stays write-only context (no column), matching the reference. The base ignores it except as the `userId` arg for a hypothetical future junction-EAV write.

## Implementation notes (post-build truths)

- **`@generated` banner (PR #373) not on this branch.** The clean-lite-ps `repository.ejs.t` carries no `@generated`/`DO NOT EDIT` banner today, so the lift emits none. When #373 lands, add the banner to the template head; the acceptance-criteria banner check applies then, not now.
- **EAV import path.** The eav override imports `FieldValueService` from `../field_values/field_value.service` (underscores), matching the existing `use-cases/create.ejs.t` convention (`../../field_values/field_value.service` from one level deeper). The Decision-5 prose's hyphenated example was illustrative.
- **Baseline is `clean` architecture; sync surface is clean-lite-ps + junction.** `test/baseline/` is generated with `generate.architecture: clean`, which routes through `templates/entity/new/backend/`. The sync-override emission lives in `templates/entity/new/clean-lite-ps/repository.ejs.t` and `templates/junction/new/repository.ejs.t`, so the **clean baseline is unchanged**. The observable codegen diff is the two junction repository snapshots in `test/junction/__snapshots__/` (regenerated; diff = exactly the new sync surface: `TSyncWrite`/`TSyncProjection` + `JunctionSyncConfig` literal + widened `extends` + parent imports + updated inherited-methods comment).
- **EJS escaping gotcha.** `refTable` and `roleColumn` literal values MUST be emitted with `<%-` (raw), not `<%=` (escapes `'` → `&#39;`).
- **Static composite helpers signature.** `parseCompositeExternalId(externalId, withRole: boolean)` and `buildCompositeExternalId(left, right, role?)` — `withRole`/`role?` select the 2- vs 3-part shape (vs the reference's role-only 3-part form).
