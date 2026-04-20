# JOB-8 — Multi-Tenancy Opt-In and Atlas Migration Docs

**Issue:** JOB-8
**Status:** Draft
**Last Updated:** 2026-04-18
**Phase:** ADR-022 Phase 1
**Depends on:** JOB-1 (schema), JOB-5 (module options), JOB-6 (Hygen CLI surface), JOB-7 (scopeable flag — concurrent)

## Overview

Two deliverables.

1. **Multi-tenancy opt-in.** When `codegen.config.yaml: jobs.multi_tenant: true`, the Hygen scaffold emits the `tenant_id` column into the generated schema (scaffold-time conditional — Q1 resolved 2026-04-19, reversing the earlier unconditional-emit proposal) AND the service layer accepts and enforces `tenantId` on every mutating and query method. JOB-8 wires both the schema conditional (via JOB-1 template) and the service-layer flag into module options and backend logic. Enabling tenancy after initial install requires a reinstall (`subsystem install jobs`) and an Atlas migration — no runtime toggle exists.
2. **Atlas docs.** `docs/CONSUMER-SETUP.md` replaces the `drizzle-kit push` recommendation with a proper Atlas migration workflow.

**Removed from scope (2026-04-18):** The upgrade command (`subsystem upgrade jobs`) was originally scoped here to preserve the existing `job_queue` table for `IJobQueue` consumers. Per project policy (no backwards compat until we have users), this is unnecessary — `subsystem install jobs` overwrites cleanly. JOB-8 is now smaller and more focused.

## Context

**Resolved 2026-04-19 — `tenant_id` is scaffold-time conditional.** The Q1 resolution reversed the earlier unconditional-emit proposal. The column is emitted into the schema only when `codegen.config.yaml: jobs.multi_tenant: true`. A project that starts with `multi_tenant: false` does not have the column at all — it does not pay the cost of an always-nullable column cluttering the schema. Enabling tenancy after initial install requires a reinstall (`subsystem install jobs`) and an Atlas migration. Per "no backwards compat until we have users" policy, this is acceptable — clean DB state is prioritised over migration convenience. JOB-8 retains the service-layer `multi_tenant` flag, tokens, and `MissingTenantIdError` surface; JOB-1's template owns the schema conditional.

**Why Atlas over drizzle-kit.** The existing `drizzle-kit push` recommendation is a dev-convenience shortcut; it does not produce reviewed migration files. Phase 1 ships real migration infrastructure.

## Architecture

```
Deliverable 1 — Multi-tenancy
  codegen.config.yaml (jobs.multi_tenant: true)
        │
        ▼
  JobsDomainModule.forRoot({ multiTenant: true })
        │  provides JOBS_MULTI_TENANT token (boolean)
        ▼
  Drizzle/Memory backends
        │  inject JOBS_MULTI_TENANT
        │  when true: read tenantId from options; write to job_run.tenant_id
        │             add eq(jobRuns.tenantId, tenantId) to claim / list queries
        │             throw MissingTenantIdError when tenantId omitted (explicit null OK)
        ▼
  All protocol methods accept optional tenantId

Deliverable 2 — Atlas docs
  docs/CONSUMER-SETUP.md
        ├── delete: "drizzle-kit push" section
        └── add: "Atlas migration workflow" section
```

## Files

| File | Action | Purpose |
|---|---|---|
| `runtime/subsystems/jobs/jobs-domain.module.ts` | modify | Add `multiTenant?: boolean` to options; provide `JOBS_MULTI_TENANT` token |
| `runtime/subsystems/jobs/jobs-domain.tokens.ts` | modify | Add `JOBS_MULTI_TENANT` Symbol |
| `runtime/subsystems/jobs/job-orchestrator.drizzle-backend.ts` | modify | Inject flag; write + filter `tenant_id` |
| `runtime/subsystems/jobs/job-run-service.drizzle-backend.ts` | modify | Inject flag; filter queries by `tenantId` |
| `runtime/subsystems/jobs/job-orchestrator.memory-backend.ts` | modify | Same tenant gate |
| `runtime/subsystems/jobs/job-run-service.memory-backend.ts` | modify | Same tenant gate |
| `runtime/subsystems/jobs/job-orchestrator.protocol.ts` | modify | Add `tenantId?: string` to `StartOptions`, `CancelOptions` |
| `runtime/subsystems/jobs/job-run-service.protocol.ts` | modify | Add `tenantId?: string` to `ListForScopeOptions` |
| `runtime/subsystems/jobs/index.ts` | modify | Re-export `JOBS_MULTI_TENANT` |
| `runtime/subsystems/jobs/__tests__/multi-tenant.unit.test.ts` | create | Unit tests for both modes against memory backend |
| `docs/CONSUMER-SETUP.md` | modify | Add "Atlas migration workflow" section; delete `drizzle-kit push` section |

## Interfaces

```typescript
// jobs-domain.module.ts
interface JobsDomainModuleOptions {
  backend: 'drizzle' | 'memory';
  multiTenant?: boolean;   // default false
}

// jobs-domain.tokens.ts
export const JOBS_MULTI_TENANT = Symbol('JOBS_MULTI_TENANT');

// Protocol additions (backward-compatible — fields optional)
interface StartOptions {
  // ... existing ...
  tenantId?: string;   // required when JOBS_MULTI_TENANT=true; ignored when false
}
interface CancelOptions {
  // ... existing ...
  tenantId?: string;
}
interface ListForScopeOptions {
  // ... existing ...
  tenantId?: string;
}

```

## Implementation Steps

### 1. Multi-tenancy — tokens + module options

- Add `JOBS_MULTI_TENANT` Symbol to `jobs-domain.tokens.ts`; export from `index.ts`.
- `JobsDomainModule.forRoot(opts)`: include `{ provide: JOBS_MULTI_TENANT, useValue: opts.multiTenant ?? false }` in providers + exports.

### 2. Backend injection

- Inject `@Inject(JOBS_MULTI_TENANT) private readonly multiTenant: boolean` in all four backend classes.
- **Write path** (`start()`): when `multiTenant === true`, include `tenantId: opts.tenantId ?? null` in insert. When `false`, always `null`.
- **Query path** (`cancel`, `listForScope`, `cancelForScope`, `rescheduleForScope`, claim query): when `multiTenant === true`, add `eq(jobRuns.tenantId, opts.tenantId)` to `WHERE`. Prevents cross-tenant ops.
- Memory backends: identical logic against `MemoryJobStore` — filter `store.runs.values()` by `r.tenantId === opts.tenantId` when flag on.

### 3. Unit tests (`__tests__/multi-tenant.unit.test.ts`)

- **Flag false:** `start()` writes `tenantId: null`; `listForScope` ignores `tenantId` filter; existing tests unaffected.
- **Flag true, correct tenant:** `start({ tenantId: 'A' })` writes `'A'`; `listForScope({ tenantId: 'A' })` returns only A.
- **Flag true, wrong tenant:** `listForScope({ tenantId: 'B' })` returns empty.
- **Cross-tenant cancel:** `cancel(runId, { tenantId: 'B' })` when run belongs to A → no-op (not-found path, no error).

All memory backend, no Docker.

### 4. Atlas docs section (`docs/CONSUMER-SETUP.md`)

Insert `## Atlas migration workflow` section after the existing `## schema.ts wiring` section. **Delete** the previous `drizzle-kit push` section outright.

Section contents:
- **Motivation** — `drizzle-kit push` bypasses reviewed migrations; Atlas produces versioned SQL.
- **Prerequisites** — Atlas CLI (`brew install ariga/tap/atlas` or `curl -sSf https://atlasgo.sh | sh`); `atlas.hcl` at project root.
- **Example `atlas.hcl`:**
  ```hcl
  data "external_schema" "drizzle" {
    program = [
      "bunx",
      "drizzle-kit",
      "introspect:pg",
      "--config=drizzle.config.ts",
    ]
  }
  env "local" {
    src = data.external_schema.drizzle.url
    url = getenv("DATABASE_URL")
    migration {
      dir = "file://migrations"
    }
  }
  ```
- **Workflow:**
  1. Author or update Drizzle schema
  2. `atlas migrate diff --env local --name <label>` → `migrations/<timestamp>_<label>.sql`
  3. Review generated SQL
  4. `atlas migrate apply --env local` to apply
  5. Commit migration file alongside schema change

## Acceptance Criteria

**Multi-tenancy**
- [ ] `multi_tenant: false` (default): the `tenant_id` column is absent from the generated schema entirely (JOB-1 template conditional); service layer does not accept or filter by `tenantId`; existing tests unaffected
- [ ] Enabling `multi_tenant: true` after initial install requires a reinstall of the jobs subsystem and an Atlas migration — no runtime toggle path exists
- [ ] `multi_tenant: true`: `start({ tenantId: 'x' })` writes it; `listForScope(..., { tenantId: 'x' })` returns only x
- [ ] Cross-tenant `cancel()` with wrong `tenantId` is no-op
- [ ] Both flag states covered in unit tests; `just test-unit` passes

**Atlas docs**
- [ ] `CONSUMER-SETUP.md` contains `## Atlas migration workflow`
- [ ] Documents `atlas migrate diff` + `atlas migrate apply` with example `atlas.hcl`
- [ ] `drizzle-kit push` section removed from `CONSUMER-SETUP.md`
- [ ] Reviewer can follow section from scratch without external references

## Testing Strategy

- **Unit (`just test-unit`):** `multi-tenant.unit.test.ts` — memory backend, both flag states; all assertions above. No Docker.
- **Manual doc test:** follow Atlas section in clean demo-app checkout; verify `migrations/` populated and `apply` succeeds against local Postgres. Document in PR.

## Open Questions

- [x] **`tenantId` enforcement strictness.** **Resolved 2026-04-18: strict — throw `MissingTenantIdError` when `multiTenant: true` and `tenantId` is missing.** Cross-tenant data leakage is the worst class of bug; surface it loudly at the call site. Tenant-less jobs (background work spanning tenants) opt in explicitly with `tenantId: null` — explicit `null` passes; missing/`undefined` throws. No separate `multi_tenant_strict` config key.
- [ ] **Atlas Drizzle integration version.** Pin minimum Atlas CLI version in docs. Confirm demo app's Atlas version.
- [x] **`drizzle-kit push` section disposition.** **Resolved 2026-04-18: delete outright.** No external users to preserve doc-anchor compatibility for.

## References

- ADR-022 — "Multi-tenancy", "Atlas migration workflow"
- `docs/specs/ADR-022-phase-1-issues.md` — JOB-8 entry
- `docs/specs/JOB-1.md` — `tenant_id` scaffold-time conditional decision (Q1 resolved 2026-04-19)
- `docs/specs/JOB-5.md` — `JobsDomainModuleOptions` shape this issue extends
- `docs/specs/JOB-6.md` — Hygen templates (`subsystem install jobs`)
- Pattern reference: existing `SubsystemInstallCommand` in `src/cli/commands/subsystem.ts`
- Doc to update: `docs/CONSUMER-SETUP.md`
