# OBS-3: Extend bridge delivery port with status histogram — Spec

**Issue:** #205 (OBS-3)
**Status:** Draft
**Last Updated:** 2026-04-23

## Overview

Add a read-only `getStatusHistogram(windowHours, tenantId?)` method to the bridge delivery port so the OBS-5 observability composer can surface counts of `pending | delivered | skipped | failed` bridge deliveries within a recent time window. Phase 1 is plain status counts only — no time bucketing. The time-bucketed variant is reserved for the Cube.js analytics layer and called out in a protocol comment. Both the Drizzle and Memory backends gain implementations that delegate tenant filtering to the existing bridge multi-tenancy pattern (`tenantId ?? null` column match, same as jobs / sync).

## Naming correction vs. the plan

The plan (`.claude/specs/epic-195-plan.md`) and issue title refer to `IBridgeDeliveryRepo`. The actual protocol in `runtime/subsystems/bridge/bridge.protocol.ts` is named `IJobBridge`. This spec extends `IJobBridge` under its real name; the plan wording should be read as "the bridge delivery port." No rename is in scope here (that's a separate refactor, and CLAUDE.md's "no backwards compat" principle means if it's renamed it happens in one PR across the subsystem, not bundled into OBS-3).

## Architecture

```
IObservability (OBS-5)
      │
      └── getBridgeDeliveryHistogram(windowHours, tenantId?)
                 │
                 ▼
          IJobBridge.getStatusHistogram()    <-- added here
                 │
       ┌─────────┴──────────┐
       ▼                    ▼
 DrizzleBridge           MemoryBridge
 DeliveryRepo            DeliveryRepo
   (GROUP BY status       (JS reduce over
    WHERE attemptedAt      Map values with
    >= now() - Nh          attemptedAt >= cutoff)
    AND tenantId match)
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/bridge/bridge.protocol.ts` | modify | Add `StatusHistogram` type, `getStatusHistogram` method signature on `IJobBridge`, Cube.js reservation comment |
| `runtime/subsystems/bridge/bridge-delivery.drizzle-backend.ts` | modify | Implement `getStatusHistogram` with `GROUP BY status` + `attemptedAt >= now() - interval` + tenant gating |
| `runtime/subsystems/bridge/bridge-delivery.memory-backend.ts` | modify | Implement `getStatusHistogram` via in-memory filter + reduce |
| `runtime/subsystems/bridge/__tests__/bridge-delivery.memory-backend.test.ts` | modify (or create if absent) | Unit tests for memory backend histogram |
| `runtime/subsystems/bridge/__tests__/bridge-delivery.drizzle-backend.test.ts` | modify (or create if absent) | Integration tests for Drizzle backend histogram (Dockerized Postgres) |
| `runtime/subsystems/bridge/index.ts` | modify (only if it re-exports types) | Re-export `StatusHistogram` if the barrel re-exports protocol types |

Locate existing adjacent tests before creating new files — if `bridge-delivery.memory-backend.test.ts` already exists, extend it; if a different naming convention is used (`*.spec.ts` vs `*.test.ts`), match it.

## Interfaces

Add to `bridge.protocol.ts`, near the existing `IJobBridge` definition:

```typescript
/**
 * Status histogram returned by IJobBridge.getStatusHistogram.
 *
 * Keys match the bridge_delivery_status enum values (bridge-delivery.schema.ts).
 * Missing statuses in the underlying result set are zero-filled so consumers
 * can render a fixed 4-row chart without branching.
 *
 * PHASE 1: plain counts only. The time-bucketed variant (per-interval series
 * for a sparkline / timeline chart) is reserved for the Cube.js analytics
 * layer (see epic-195-architecture-decisions.md §6) and must NOT be added to
 * this protocol. If a consumer needs buckets, that's a signal to route the
 * query through Cube, not to grow the core contract.
 */
export type StatusHistogram = {
  pending: number;
  delivered: number;
  skipped: number;
  failed: number;
};
```

Extend `IJobBridge`:

```typescript
export interface IJobBridge {
  // ... existing methods unchanged ...

  /**
   * Count bridge_delivery rows by status, filtered to rows where
   * attemptedAt >= (now - windowHours) and (optionally) tenantId matches.
   *
   * Tenant semantics mirror the jobs subsystem (job-orchestrator.protocol.ts):
   *   - tenantId omitted or explicit undefined: no tenant filter (counts across
   *     all tenants — appropriate for framework-internal admin dashboards).
   *   - tenantId === null: match rows where tenant_id IS NULL (cross-tenant
   *     housekeeping deliveries).
   *   - tenantId === '<string>': match rows where tenant_id = '<string>'.
   *
   * Returns all-zero StatusHistogram when no rows match — never empty object,
   * never undefined. Consumers rely on fixed keys for rendering.
   *
   * PHASE 1: plain counts only. Do NOT add a bucketing / time-series variant
   * to this method or the protocol — see StatusHistogram JSDoc.
   */
  getStatusHistogram(
    windowHours: number,
    tenantId?: string | null,
  ): Promise<StatusHistogram>;
}
```

## Implementation Steps

### 1. Extend the protocol (`bridge.protocol.ts`)

- Add the `StatusHistogram` type export with the JSDoc above (Cube.js reservation explicit)
- Add `getStatusHistogram` to `IJobBridge` with JSDoc describing tenant semantics and zero-fill guarantee
- Keep the method at the bottom of the interface below `markFailed` — clear read/write separation
- No changes to existing methods

### 2. Implement Drizzle backend (`bridge-delivery.drizzle-backend.ts`)

Pseudocode:

```
async getStatusHistogram(windowHours, tenantId?):
  build cutoff expression:
    sql`now() - make_interval(hours => ${windowHours})`
    (or: sql`now() - (${windowHours} || ' hours')::interval`)

  build where predicate:
    conditions = [gte(bridgeDelivery.attemptedAt, cutoff)]
    if tenantId === null:
      conditions.push(isNull(bridgeDelivery.tenantId))
    else if typeof tenantId === 'string':
      conditions.push(eq(bridgeDelivery.tenantId, tenantId))
    # tenantId === undefined → no tenant filter

  rows = await db
    .select({
      status: bridgeDelivery.status,
      count: sql<number>`count(*)::int`,
    })
    .from(bridgeDelivery)
    .where(and(...conditions))
    .groupBy(bridgeDelivery.status)

  histogram = { pending: 0, delivered: 0, skipped: 0, failed: 0 }
  for row of rows:
    histogram[row.status] = Number(row.count)
  return histogram
```

Notes:
- Use existing `eq`, `and`, plus import `gte`, `isNull`, `sql` from `drizzle-orm`
- Cast `count(*)` to `int` (or `number`) in the select so the driver returns a `number` not a `string` — Postgres returns `bigint` for count otherwise
- No `tx` parameter — this is a read, never inside a per-event drain tx
- No `assertTenantId` call — that helper is for writes that need to fail fast on missing tenant context; reads with `undefined` deliberately mean "cross-tenant view" here. Document this choice in a code comment.
- Does NOT touch the `BRIDGE_MULTI_TENANT` token — observability reads are intentionally tenant-agnostic unless the caller specifies

### 3. Implement Memory backend (`bridge-delivery.memory-backend.ts`)

Pseudocode:

```
async getStatusHistogram(windowHours, tenantId?):
  cutoffMs = Date.now() - windowHours * 3_600_000
  histogram = { pending: 0, delivered: 0, skipped: 0, failed: 0 }

  for record of this.deliveries.values():
    if record.attemptedAt.getTime() < cutoffMs: continue
    if tenantId === null and record.tenantId !== null: continue
    if typeof tenantId === 'string' and record.tenantId !== tenantId: continue
    # tenantId === undefined → no tenant filter
    histogram[record.status] += 1

  return histogram
```

Notes:
- `record.attemptedAt` is always a `Date` per the memory backend's materialization step
- Zero-fill guaranteed by starting from the fixed shape

### 4. Unit tests — memory backend

Tests to add:

- `returns all-zero histogram when no deliveries exist`
- `counts a single delivery in each status correctly (pending/delivered/skipped/failed)`
- `excludes deliveries outside the windowHours cutoff`
- `includes deliveries exactly at the boundary` (cutoff comparison is `>=`)
- `tenantId undefined matches all rows regardless of tenant`
- `tenantId === null matches only rows with tenantId IS NULL`
- `tenantId === 't-1' matches only rows where tenantId === 't-1'`
- `returns zero-fill for statuses with no matching rows`

Setup: seed the memory repo via `insertDelivery` (populate `attemptedAt` explicitly to control time) then call markDelivered/markSkipped/markFailed as needed.

### 5. Integration tests — Drizzle backend

- Same matrix as memory tests
- Extra: verify `attemptedAt >= now() - interval` evaluates on the server clock (don't depend on client time sync)
- Extra: verify `count(*)` comes back as a `number`, not a string — regression guard for the `::int` cast

### 6. Barrel export (if applicable)

Check `runtime/subsystems/bridge/index.ts`. If it re-exports protocol types, add `StatusHistogram`.

## Testing Strategy

- **Unit (memory backend):** full matrix of window-cutoff + tenant-filter combinations; fast, runs in `just test-unit`
- **Integration (Drizzle backend):** minimum one happy-path case per tenant-filter mode + one window-cutoff case; runs under `just test-family` / `just test-integration` with Docker Postgres
- **No consumer tests in this PR** — OBS-5 will add composer tests that exercise the method end-to-end through `IObservability`

## Open Questions

- [ ] Does the existing bridge test file use `*.test.ts` or `*.spec.ts`? (Detect from siblings before creating new tests.)
- [ ] `count(*)::int` vs `count(*)::int4` vs a JS `Number(row.count)` cast — any established convention in the jobs backend worth mirroring? (Check once OBS-2 lands.)
- [ ] Should `windowHours <= 0` throw or return all-zero? Recommend throwing `RangeError` to fail loud; confirm with planner.
- [ ] Should there be an upper bound on `windowHours` (e.g., reject > 8760)? Currently unbounded; leaning no (caller's responsibility) but flag for review.
- [ ] This is the first read method on `IJobBridge` that intentionally bypasses `assertTenantId`. The no-assert policy for reads is new territory and should be documented in the skill (`.claude/skills/bridge/SKILL.md`) per CLAUDE.md living-documentation rule — likely a follow-up task for OBS-1.

## References

- Locked decisions: `.claude/specs/epic-195-architecture-decisions.md` §4, §5, §6
- Plan entry: `.claude/specs/epic-195-plan.md` → OBS-3
- Protocol: `runtime/subsystems/bridge/bridge.protocol.ts` (interface to extend: `IJobBridge`)
- Schema: `runtime/subsystems/bridge/bridge-delivery.schema.ts`
- Drizzle backend: `runtime/subsystems/bridge/bridge-delivery.drizzle-backend.ts`
- Memory backend: `runtime/subsystems/bridge/bridge-delivery.memory-backend.ts`
- Tenant helper: `runtime/subsystems/bridge/assert-tenant-id.ts`
- Sibling pattern: OBS-2 (`IJobRunService.countByPoolAndStatus`) — mirror its tenant-filter conventions once it lands
