# A9: BaseRepository\<TEntity\>

**Status:** Draft
**Last Updated:** 2026-04-12
**Depends on:** None (foundational)
**References:** ADR-005, contact module sketch

## Overview

Hand-written abstract class at `shared/base-classes/base-repository.ts`. Provides standard CRUD via Drizzle ORM. Every generated repository extends this. Family-specific bases (CrmEntityRepository, etc.) extend it in v0.1 without any changes to BaseRepository.

## Interface

```typescript
abstract class BaseRepository<TEntity> {
  protected abstract readonly table: PgTableWithColumns<any>;
  protected readonly behaviors: BehaviorConfig = {
    timestamps: false,
    softDelete: false,
    userTracking: false,
  };
  protected readonly db: DrizzleClient;

  constructor(db: DrizzleClient) { this.db = db; }

  // Reads
  findById(id: string): Promise<TEntity | null>;
  findByIds(ids: string[]): Promise<TEntity[]>;
  list(options?: ListOptions): Promise<TEntity[]>;
  count(where?: SQL): Promise<number>;
  exists(id: string): Promise<boolean>;

  // Writes
  create(input: Partial<TEntity>): Promise<TEntity>;
  update(id: string, input: Partial<TEntity>): Promise<TEntity>;
  delete(id: string): Promise<void>;  // soft or hard based on behaviors.softDelete
  upsertMany(inputs: Array<Partial<TEntity>>): Promise<TEntity[]>;  // naive default, family overrides

  // Protected helpers
  protected baseQuery(): SelectBuilder;  // auto-filters soft-deleted rows
  protected withTimestamps(input, mode: 'create'|'update'): Record<string, unknown>;
}

interface ListOptions {
  where?: SQL;
  limit?: number;
  offset?: number;
  orderBy?: Column | SQL;
}

interface BehaviorConfig {
  timestamps: boolean;
  softDelete: boolean;
  userTracking: boolean;
}
```

## Implementation Details

**`baseQuery()`**: `db.select().from(table)` + `.where(isNull(table.deletedAt))` when softDelete=true.

**`withTimestamps(input, mode)`**: On create: merge `{createdAt: now, updatedAt: now}`. On update: merge `{updatedAt: now}`.

**`findById`**: `baseQuery().where(eq(table.id, id)).limit(1)` → first result or null.

**`findByIds`**: Early return `[]` for empty array. `baseQuery().where(inArray(table.id, ids))`.

**`list`**: `baseQuery()` + optional where/limit/offset/orderBy from ListOptions.

**`delete`**: If softDelete: `update(table).set({deletedAt: new Date()})`. Else: `delete(table).where(eq(id))`.

**`upsertMany`**: Naive default: `Promise.all(inputs.map(this.create))`. CrmEntityRepository overrides with proper conflict-target upsert in v0.1.

## NestJS DI Pattern

```typescript
// BaseRepository is NOT @Injectable (abstract)
// Concrete repos are @Injectable with DRIZZLE injection:
@Injectable()
export class ContactRepository extends BaseRepository<Contact> {
  readonly table = contacts;
  constructor(@Inject(DRIZZLE) db: DrizzleClient) { super(db); }
}
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `shared/base-classes/base-repository.ts` | create | Abstract base class |
| `shared/base-classes/index.ts` | create | Barrel export |
| `shared/types/drizzle.ts` | create | DrizzleClient type alias |
| `shared/constants/tokens.ts` | create | DRIZZLE injection token |
| `shared/base-classes/base-repository.spec.ts` | create | Tests with real Postgres |

## Acceptance Criteria

- [ ] `ContactRepository extends BaseRepository<Contact>` compiles
- [ ] Inherits all 9 CRUD methods without overrides
- [ ] `behaviors.softDelete=true`: delete sets deletedAt, list excludes soft-deleted
- [ ] `behaviors.timestamps=true`: create sets both timestamps, update sets updatedAt
- [ ] `CrmEntityRepository<T> extends BaseRepository<T>` can be added later without changes
- [ ] `findByIds([])` returns `[]` without DB error
- [ ] All tests pass against real Postgres (TestContainers)
