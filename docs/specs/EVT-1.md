# EVT-1 — `domain_events` Schema Upgrade: `pool`, `direction`, `tenant_id`

**Issue:** EVT-1
**Status:** Stub
**Phase:** ADR-024 Phase 1
**Depends on:** Nothing — this is the schema foundation.

## Overview

Add `pool`, `direction`, and (conditionally) `tenant_id` columns to the `domain_events` outbox table. Add a `(pool, status, occurred_at)` composite index for pool-filtered drain queries. This PR is purely additive to the existing schema — no existing logic is changed.

## Context

**What exists.** `runtime/subsystems/events/domain-events.schema.ts` defines the `domain_events` table with columns: `id`, `type`, `aggregate_id`, `aggregate_type`, `payload`, `occurred_at`, `processed_at`, `status`, `error`, `metadata`. Direction and pool information currently lives inside the JSON `metadata` column — this means pool-based drain filtering requires JSON unpacking on every poll row, and adds no index benefit.

**What this PR adds.** Three new columns promoted to first-class status and one new index. The `metadata` JSON continues to carry these values for protocol stability; the first-class columns are an optimization that enables the drain loop to filter without touching `metadata`.

**Why `tenant_id` is conditional.** Follows JOB-1 / EVT-Q1 resolution: scaffold-time include/exclude. The column appears only when `codegen.config.yaml: events.multi_tenant: true`. Consumers who never enable multi-tenancy have a cleaner schema. Enabling after initial install requires a reinstall + Atlas migration — acceptable per CLAUDE.md operating principles.

## Architecture

```
domain-events.schema.ts
  ├── existing columns (unchanged)
  ├── pool text (nullable)          ← populated by DrizzleEventBus.publish() in EVT-4
  ├── direction text (nullable)     ← populated by DrizzleEventBus.publish() in EVT-4
  └── tenant_id text (nullable)     ← conditional on events.multi_tenant: true
  
Indexes:
  (status, occurred_at)             ← existing
  (aggregate_id, aggregate_type)    ← existing
  (pool, status, occurred_at)       ← NEW — enables per-pool drain
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/events/domain-events.schema.ts` | modify | Add three columns and new index |
| `runtime/subsystems/events/index.ts` | modify | Ensure `DomainEventRecord` re-export picks up new fields |

## Interfaces

`DomainEventRecord` (inferred via `InferSelectModel`) gains the three new optional fields. No interface changes required — the type is derived automatically.

## Implementation Steps

1. Add `pool: text('pool')` (nullable, no default) to the `domainEvents` pgTable definition.
2. Add `direction: text('direction')` (nullable, no default).
3. Add `tenantId: text('tenant_id')` (nullable) — add only when the config flag is set; the conditional emit logic lives in EVT-8's scaffold template, but the column definition must be present in the schema file with a comment: `// conditional: emitted only when events.multi_tenant: true`.
4. Add `(pool, status, occurred_at)` composite index in the table's second argument (index callback).
5. Verify existing indexes are still present.
6. Update the module-level JSDoc comment to describe the new columns.

## Acceptance Criteria

- [ ] `pool text` column present, nullable.
- [ ] `direction text` column present, nullable.
- [ ] `tenant_id text` column present with `// conditional` annotation.
- [ ] `(pool, status, occurred_at)` composite index declared.
- [ ] Existing `(status, occurred_at)` and `(aggregate_id, aggregate_type)` indexes preserved.
- [ ] `DomainEventRecord` inferred type includes the new fields.
- [ ] Unit test: schema imports without error; column names are present.

## Testing Strategy

Unit test in `runtime/subsystems/events/__tests__/domain-events.schema.test.ts` (or similar path): import `domainEvents`, assert `._.columns` contains `pool`, `direction`, `tenant_id`. No Docker needed.

## Open Questions

None — EVT-Q1 (tenant_id conditional) resolved by planning phase before implementation starts.

## References

- `docs/adrs/ADR-024-events-domain-formalization.md` §"domain_events schema upgrade"
- `docs/specs/EVT-phase-1-issues.md` §EVT-1
- JOB-1 — the template this follows for conditional column annotation
