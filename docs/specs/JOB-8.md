# JOB-8 — Multi-Tenancy Opt-In and Atlas Migration Docs

**Issue:** JOB-8
**Status:** Implemented
**Last Updated:** 2026-04-19
**Phase:** ADR-022 Phase 1
**Depends on:** JOB-1 (schema), JOB-5 (module options), JOB-6 (Hygen CLI surface + schema conditional), JOB-7 (scopeable flag — concurrent)

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
| `runtime/subsystems/jobs/jobs-domain.module.ts` | modify | Add `multiTenant?: boolean` to options (landed in JOB-5 as typed reservation); provide `JOBS_MULTI_TENANT` token |
| `runtime/subsystems/jobs/jobs-domain.tokens.ts` | modify | Add `JOBS_MULTI_TENANT` Symbol (co-located with existing tokens rather than a separate `*.tokens.ts` file — spec pre-JOB-8 drift; single-tokens-file keeps the import surface tight) |
| `runtime/subsystems/jobs/jobs-errors.ts` | modify | Add `MissingTenantIdError` class |
| `runtime/subsystems/jobs/job-orchestrator.drizzle-backend.ts` | modify | Inject flag; write + filter `tenant_id`; silent cross-tenant no-op on `cancel` |
| `runtime/subsystems/jobs/job-run-service.drizzle-backend.ts` | modify | Inject flag; filter queries by `tenantId`; propagate to cascade cancel |
| `runtime/subsystems/jobs/job-orchestrator.memory-backend.ts` | modify | Same tenant gate; internal replace-collision uses incumbent's tenant; terminate-cascade uses run's own tenant |
| `runtime/subsystems/jobs/job-run-service.memory-backend.ts` | modify | Same tenant gate |
| `runtime/subsystems/jobs/job-orchestrator.protocol.ts` | modify | Add `tenantId?: string \| null` to `StartOptions`, `CancelOptions` (explicit `null` opts into cross-tenant work) |
| `runtime/subsystems/jobs/job-run-service.protocol.ts` | modify | Add `tenantId?: string \| null` to `ListForScopeOptions`; new `CancelForScopeOptions` + `RescheduleForScopeOptions` with same field (bulk-scoped methods need the gate too) |
| `runtime/subsystems/jobs/job-orchestration.schema.ts` | modify | Remove orphan `// scaffold-time conditional — see JOB-8` comment above `tenantId` column (the conditional lives in JOB-6's Hygen template; the runtime source always emits the column) |
| `runtime/subsystems/jobs/index.ts` | modify | Re-export `JOBS_MULTI_TENANT`, `MissingTenantIdError`, new scope options types |
| `src/__tests__/runtime/subsystems/multi-tenant.unit.spec.ts` | create | Unit tests for both flag states against memory backend (JOB-4 canonical test path — `runtime/.../__tests__/*.unit.test.ts` was spec drift; the repository convention is `src/__tests__/runtime/subsystems/*.spec.ts`) |
| `src/__tests__/runtime/subsystems/job-orchestrator.unit.spec.ts` | modify | Pass third `multiTenant: false` arg to `new MemoryJobOrchestrator(...)` constructor |
| `src/__tests__/runtime/subsystems/job-worker.unit.spec.ts` | modify | Same — `multiTenant: false` on both MemoryJobOrchestrator + MemoryJobRunService |
| `docs/CONSUMER-SETUP.md` | modify | Add "Atlas migration workflow" section after "schema.ts wiring"; pin Atlas CLI `>= 0.24.0`. No `drizzle-kit push` section existed to delete — the doc never recommended it in the first place; ADR-022 referenced "superseding" an older recommendation that lived in earlier drafts of the doc |

## Interfaces

```typescript
// jobs-domain.module.ts
interface JobsDomainModuleOptions {
  backend: 'drizzle' | 'memory';
  multiTenant?: boolean;   // default false
}

// jobs-domain.tokens.ts
export const JOBS_MULTI_TENANT = Symbol('JOBS_MULTI_TENANT');

// Protocol additions. Field is optional on the options types; existing call
// sites compile unchanged. Note `| null`: explicit `null` opts into
// cross-tenant work (row persisted with tenant_id NULL; reads match NULL).
// `undefined` throws `MissingTenantIdError` when the flag is on.
interface StartOptions {
  // ... existing ...
  tenantId?: string | null;
}
interface CancelOptions {
  // ... existing ...
  tenantId?: string | null;
}
interface ListForScopeOptions {
  // ... existing ...
  tenantId?: string | null;
}
// New in JOB-8 — the scoped bulk ops need the same gate.
interface CancelForScopeOptions {
  tenantId?: string | null;
}
interface RescheduleForScopeOptions {
  tenantId?: string | null;
}

```

## Implementation Steps

### 1. Multi-tenancy — tokens + module options

- Add `JOBS_MULTI_TENANT` Symbol to `jobs-domain.tokens.ts`; export from `index.ts`.
- `JobsDomainModule.forRoot(opts)`: include `{ provide: JOBS_MULTI_TENANT, useValue: opts.multiTenant ?? false }` in providers + exports.

### 2. Backend injection

- Inject `@Inject(JOBS_MULTI_TENANT) private readonly multiTenant: boolean` in all four backend classes.
- **Write path** (`start()`): call `resolveTenantId('start', opts.tenantId)` — strict gate. When `multiTenant === true` and `tenantId === undefined`, throw `MissingTenantIdError('start')`. Otherwise write the resolved value (`null` or string) into the new row. When `multiTenant === false`, always `null`.
- **Targeted-read / mutate path** (`cancel`, `listForScope`, `cancelForScope`, `rescheduleForScope`): when `multiTenant === true`, apply the same strict gate, then add `eq(jobRuns.tenantId, tenantId)` (or `isNull(jobRuns.tenantId)` for explicit `null`) to the `WHERE`. Cross-tenant ops naturally no-op.
- **Claim loop (`claimNext`) is cross-tenant by design.** See Open Questions resolution above. The worker has no tenant context; filtering here would require per-tenant pools. Persisting `tenant_id` at write time + filtering at read time is sufficient to prevent cross-tenant data leakage; the claim path is not a data-exposure surface because handlers receive the full run row including `tenantId`.
- Memory backends: identical logic against `MemoryJobStore` — filter `store.runs.values()` by `r.tenantId === resolvedTenantId` when flag on.
- Internal cascade paths (`cancelForScope` → `orchestrator.cancel`, `markFailed` → `cancel`, `replace` collision mode → `cancelLocked`) must **propagate the validated tenantId** so the per-row guard inside `cancel` doesn't surprise-throw. Each such site passes either the scope's `tenantId` (scope → orchestrator) or the incumbent run's own `tenantId` (system-internal cascade) — never `undefined`.

### 3. Unit tests (`src/__tests__/runtime/subsystems/multi-tenant.unit.spec.ts`)

- **Flag false:** `start()` writes `tenantId: null` even if a `tenantId` option is passed; `listForScope` ignores `tenantId` filter; `start()` without `tenantId` does not throw.
- **Flag true, correct tenant:** `start({ tenantId: 'A' })` writes `'A'`; `listForScope({ tenantId: 'A' })` returns only A.
- **Flag true, wrong tenant:** `listForScope({ tenantId: 'B' })` returns empty.
- **Flag true, cross-tenant cancel:** `cancel(runId, { tenantId: 'B' })` when run belongs to A → silent no-op; run stays pending.
- **Flag true, missing `tenantId` (undefined):** `start()`, `cancel()`, `listForScope()`, `cancelForScope()`, `rescheduleForScope()` all throw `MissingTenantIdError`; error message names the method.
- **Flag true, explicit `null`:** `start({ tenantId: null })` succeeds; row persisted with `tenant_id: null`; `listForScope({ tenantId: null })` returns only NULL-tenant rows; `cancel({ tenantId: null })` only cancels NULL-tenant runs.

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
- [x] `multi_tenant: false` (default): the `tenant_id` column is **always emitted** (nullable) on `job_run`. Runtime code reads `row.tenantId: string | null` uniformly. Service layer does not require or filter by `tenantId`. (Reversed JOB-Q1 on 2026-04-20 as part of the F9 integration fix; see ADR-022 revision note 2026-04-20. Originally spec'd as "column absent entirely" — that turned out to force tenant-awareness into every runtime call site. `job` and `job_step` do not carry `tenant_id`; tenant scope is enforced at the `job_run` boundary only.)
- [x] `multi_tenant: true`: the `job_run.tenant_id` column stays **nullable** in the DB — multi-tenancy is enforced at the service layer (`JOBS_MULTI_TENANT` DI token, `MissingTenantIdError` on `undefined`) rather than via a `NOT NULL` constraint. This preserves the first-class "explicit `null` tenant for cross-tenant background work" contract in `jobs-errors.ts`. No schema-level diff between flag states — toggling only changes the `JOBS_MULTI_TENANT` provider value.
- [x] `multi_tenant: true`: `start({ tenantId: 'x' })` writes it; `listForScope(..., { tenantId: 'x' })` returns only x
- [x] Cross-tenant `cancel()` with wrong `tenantId` is no-op (silent — no existence leak)
- [x] Strict enforcement: `undefined` `tenantId` throws `MissingTenantIdError` naming the method; explicit `null` passes for cross-tenant background work
- [x] Both flag states covered in unit tests; `just test-unit` passes (813 total pass, including 18 new multi-tenant tests with 24 expect() calls in `src/__tests__/runtime/subsystems/multi-tenant.unit.spec.ts`)

**Atlas docs**
- [x] `CONSUMER-SETUP.md` contains `## Atlas migration workflow`
- [x] Documents `atlas migrate diff` + `atlas migrate apply` with example `atlas.hcl`
- [x] Pins Atlas CLI `>= 0.24.0` in prerequisites (current recent-stable; bumpable in follow-up)
- [x] Motivation section explains why Atlas beats `drizzle-kit push` (reviewable SQL, destructive-change detection, CI lint)
- [x] Reviewer can follow section from scratch without external references

## Testing Strategy

- **Unit (`just test-unit`):** `multi-tenant.unit.test.ts` — memory backend, both flag states; all assertions above. No Docker.
- **Manual doc test:** follow Atlas section in clean demo-app checkout; verify `migrations/` populated and `apply` succeeds against local Postgres. Document in PR.

## Open Questions

- [x] **`tenantId` enforcement strictness.** **Resolved 2026-04-18: strict — throw `MissingTenantIdError` when `multiTenant: true` and `tenantId` is missing.** Cross-tenant data leakage is the worst class of bug; surface it loudly at the call site. Tenant-less jobs (background work spanning tenants) opt in explicitly with `tenantId: null` — explicit `null` passes; missing/`undefined` throws. No separate `multi_tenant_strict` config key.
- [x] **Atlas Drizzle integration version.** **Resolved 2026-04-19 in this PR: pinned `>= 0.24.0`** in `docs/CONSUMER-SETUP.md` prerequisites. No demo-app present in this repo to reconcile against; version is a recent stable per atlasgo.io and can be bumped in a follow-up as the ecosystem moves.
- [x] **`drizzle-kit push` section disposition.** **Resolved 2026-04-18: delete outright.** No external users to preserve doc-anchor compatibility for. (Note: the live `CONSUMER-SETUP.md` on `main` did not actually carry a `drizzle-kit push` section to delete — that recommendation lived in earlier drafts of the doc and in auxiliary docs only. The Atlas section replaces it as the first-class story either way.)
- [x] **Claim-loop tenant gating.** **Resolved 2026-04-19: cross-tenant by design.** The `JobWorker` claim query (`claimNext(pool)` in both orchestrators) does NOT filter by `tenant_id`. The worker has no tenant context — it claims any pending row in its pool regardless of tenant. `tenant_id` is populated at `start`-time and enforced on *targeted* reads (`cancel`, `listForScope`, `cancelForScope`, `rescheduleForScope`). This matches how the job is routed: the handler receives the claimed run and can read `run.tenantId` to scope its own side-effects. Filtering the claim loop would require partitioning workers per tenant, which defeats the pool abstraction.
- [x] **Token file placement.** **Resolved 2026-04-19 in this PR: co-located with `JOB_ORCHESTRATOR` etc. in `runtime/subsystems/jobs/jobs-domain.tokens.ts`.** The original spec line item implied a separate `jobs-domain.tokens.ts` — it already exists and already holds the other three tokens, so `JOBS_MULTI_TENANT` joined them rather than getting a new file. One token file per subsystem is the repo convention.

## References

- ADR-022 — "Multi-tenancy", "Atlas migration workflow"
- `docs/specs/ADR-022-phase-1-issues.md` — JOB-8 entry
- `docs/specs/JOB-1.md` — `tenant_id` scaffold-time conditional decision (Q1 resolved 2026-04-19)
- `docs/specs/JOB-5.md` — `JobsDomainModuleOptions` shape this issue extends
- `docs/specs/JOB-6.md` — Hygen templates (`subsystem install jobs`)
- Pattern reference: existing `SubsystemInstallCommand` in `src/cli/commands/subsystem.ts`
- Doc to update: `docs/CONSUMER-SETUP.md`
