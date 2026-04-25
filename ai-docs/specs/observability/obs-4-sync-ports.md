# OBS-4: Extend sync ports — `listRecent` + `listAll` cursors — Spec

**Issue:** #206 (OBS-4)
**Status:** Draft
**Last Updated:** 2026-04-23

## Overview

Add two read methods to the sync subsystem's existing ports so the OBS-5 composer can surface recent sync runs and current cursor state. `ISyncRunRecorder.listRecent(limit, subscriptionId?, tenantId?)` returns recent `sync_runs` rows; `ICursorStore.listAll(tenantId?)` returns one snapshot per `sync_subscriptions` row. Both gain a read method on protocol + Drizzle backend + Memory backend.

## Load-bearing corrections vs. plan

1. **Filter parameter**: plan said `integrationId` for `listRecent`, but `sync_runs` FKs to `sync_subscriptions` (JOIN required). A single integration can own multiple subscriptions. **Spec uses `subscriptionId` as the primary filter** (natural FK). If an integration-wide view is needed later, add as follow-up.
2. **Record count field**: spec uses `recordsProcessed` from `sync_runs` (denormalized, free) rather than counting `sync_run_items` rows (correlated subquery per run).
3. **Memory backends lack subscription metadata** — `MemoryRunRecorder` stores `subscriptionId` but no `integrationId`; `MemoryCursorStore` has only `subscriptionId → cursor`. See Open Questions #1.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/sync/sync-run-recorder.protocol.ts` | modify | Add `SyncRunSummary` type + `listRecent` |
| `runtime/subsystems/sync/sync-run-recorder.drizzle-backend.ts` | modify | JOIN sync_runs → sync_subscriptions, ORDER BY started_at DESC LIMIT |
| `runtime/subsystems/sync/sync-run-recorder.memory-backend.ts` | modify | Scan runs Map, sort, slice |
| `runtime/subsystems/sync/sync-cursor-store.protocol.ts` | modify | Add `CursorSnapshot` type + `listAll` |
| `runtime/subsystems/sync/sync-cursor-store.drizzle-backend.ts` | modify | SELECT from sync_subscriptions |
| `runtime/subsystems/sync/sync-cursor-store.memory-backend.ts` | modify | Iterate; needs metadata side-map (see Open Questions) |
| `runtime/subsystems/sync/__tests__/sync-run-recorder.memory-backend.spec.ts` | create or modify | Unit tests |
| `runtime/subsystems/sync/__tests__/sync-cursor-store.memory-backend.spec.ts` | create or modify | Unit tests |
| Integration test files (Drizzle) | create or modify | Postgres integration tests |

## Interfaces

### `sync-run-recorder.protocol.ts`

```typescript
export interface SyncRunSummary {
  readonly id: string;
  readonly subscriptionId: string;
  /** Resolved by Drizzle backend via JOIN; empty string from memory if no metadata seeded. */
  readonly integrationId: string;
  readonly status: 'running' | 'success' | 'no_changes' | 'failed';
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly recordsProcessed: number;
  readonly tenantId: string | null;
}

export interface ISyncRunRecorder {
  // ... existing startRun, recordItem, completeRun
  listRecent(
    limit: number,
    subscriptionId?: string,
    tenantId?: string | null,
  ): Promise<SyncRunSummary[]>;
}
```

### `sync-cursor-store.protocol.ts`

```typescript
export interface CursorSnapshot {
  readonly subscriptionId: string;
  readonly integrationId: string;
  readonly adapter: string;
  readonly domain: string;
  readonly externalRef: string | null;
  readonly cursor: unknown | null;
  readonly lastSyncAt: Date | null;
  readonly updatedAt: Date;
  readonly tenantId: string | null;
}

export interface ICursorStore {
  // ... existing get, put
  listAll(tenantId?: string | null): Promise<CursorSnapshot[]>;
}
```

## Implementation Steps

1. **Extend `ISyncRunRecorder` protocol** — add `SyncRunSummary` + `listRecent`
2. **Implement `DrizzleSyncRunRecorder.listRecent`**:
   - JOIN `syncRuns` against `syncSubscriptions` on `subscription_id`
   - WHERE: optional `eq(syncRuns.subscriptionId, subscriptionId)`; tenant via `assertTenantId` + `eq(syncRuns.tenantId, tenantId)` when `multiTenant`
   - `ORDER BY syncRuns.startedAt DESC LIMIT limit`
   - Map to `SyncRunSummary`
3. **Implement `MemoryRunRecorder.listRecent`**:
   - Optionally extend `MemoryRunRecord` with a seedable `subscriptions: Map<subId, { integrationId, ... }>` side-map (see Open Question #1)
   - Filter `runs.values()`, sort desc by `startedAt`, slice to `limit`
   - Tenant param accepted but not enforced (matches existing memory contract)
4. **Extend `ICursorStore` protocol** — add `CursorSnapshot` + `listAll`
5. **Implement `PostgresCursorStore.listAll`**:
   - `assertTenantId` when multiTenant
   - WHERE: optional `eq(syncSubscriptions.tenantId, tenantId)`
   - SELECT full row, ORDER BY `updated_at DESC`
   - Map `id → subscriptionId`
6. **Implement `MemoryCursorStore.listAll`**:
   - Needs metadata side-map (see Open Question #1)
   - Iterate, sort by `updatedAt` desc, ignore `tenantId`
   - Return `[]` when empty

## Test matrix

Memory:
- empty returns `[]`
- filters work (subscriptionId, tenantId no-op)
- ordering correct
- limit truncates

Drizzle integration:
- JOIN returns correct `integrationId` per run
- tenant scoping on/off, missing tenantId throws `MissingTenantIdError`
- ordering + limit respected
- empty returns `[]`

## Open Questions

- [ ] **Memory backends lack subscription metadata.** Recommendation: add a public seedable `subscriptions: Map<subId, { integrationId, adapter, domain, externalRef, ... }>` on each memory backend for tests. Alternative: return empty strings for fields memory can't know. Prefer the seedable map — more honest.
- [ ] **Filter on `subscriptionId` vs `integrationId` for `listRecent`.** Spec uses `subscriptionId` (natural FK). If the OBS-5 composer API surface needs integration-wide view, add in a follow-up PR with a JOIN-side filter on `sync_subscriptions.integration_id`.
- [ ] **`recordsProcessed` vs `itemCount`.** Spec uses `sync_runs.records_processed` (denormalized). If a true `COUNT(sync_run_items)` is required, flag — it's a correlated subquery per run.
- [ ] **Test file layout convention.** Confirm `runtime/subsystems/sync/__tests__/` vs `src/__tests__/sync/` by checking adjacent existing tests.

## References

- Decisions: `.claude/specs/epic-195-architecture-decisions.md` §4
- Plan: `.claude/specs/epic-195-plan.md` OBS-4
- Schema: `runtime/subsystems/sync/sync-audit.schema.ts`
- Tenant helper: `runtime/subsystems/sync/sync-errors.ts` (`assertTenantId`)
- Sibling precedent: OBS-2 (mirror tenant-filter conventions)
- Skill: `.claude/skills/sync/SKILL.md`
