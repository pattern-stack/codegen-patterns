# JOB-2 — Protocol Interfaces and Base Handler Types

**Issue:** JOB-2
**Status:** Draft
**Last Updated:** 2026-04-20
**Depends on:** JOB-1 (Drizzle schemas — row types imported by protocols)
**Blocks:** JOB-3 (Drizzle backends), JOB-4 (Memory backends), JOB-7 (scopeable flag uses `ScopeRef` shape from this issue)

## Overview

Define the stable public API surface for the job orchestration domain layer: three protocol interfaces (`IJobOrchestrator`, `IJobRunService`, `IJobStepService`), the `JobHandlerBase` abstract class with `JobContext<TInput>`, the `@JobHandler` decorator with its full metadata shape, the `ParentClosePolicy` enum, and injection tokens. No backend implementations ship in this PR. JOB-1's Drizzle schema (tables, enums, row types) is preserved untouched; JOB-2 only adds new files alongside it.

## Context

JOB-1 removed the legacy executor layer in its entirety — `IJobQueue`, `JOB_QUEUE`, the four backends (Drizzle/BullMQ/Redis/Memory), and `jobs.module.ts` are all gone. What remains in `runtime/subsystems/jobs/` at the start of JOB-2 is the orchestration schema (`job`, `job_run`, `job_step` tables + enums + row types) and a barrel that re-exports those symbols.

ADR-022's single-layer architecture means there is no "above" and "below": the orchestrator writes `job_run` rows directly, and the JobWorker of JOB-3 polls `job_run` via `SELECT ... FOR UPDATE SKIP LOCKED`. No dispatch port sits between them.

JOB-2 delivers only the TypeScript types, interfaces, and the `@JobHandler` decorator/registry that every downstream PR (backends, modules, templates) depends on. It is the contract — nothing else.

## Architecture

```
Consumer use case
      │  @Inject(JOB_ORCHESTRATOR)
      ▼
IJobOrchestrator ──start/cancel/replay──▶ (implemented by JOB-3/JOB-4 backends)
      │
      └── uses ──▶ IJobRunService   (scope queries, bulk cancel, reschedule)
      └── uses ──▶ IJobStepService  (step record + fetch for memoization)

@JobHandler decorator ──registers──▶ handler registry (consumed by JOB-5 module)
JobHandlerBase<TInput, TOutput>
      │
      └── run(ctx: JobContext<TInput>): Promise<TOutput>  ← user implements this
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/jobs/job-orchestrator.protocol.ts` | create | `IJobOrchestrator`, `StartOptions`, `CancelOptions`, `JobRun` return shape |
| `runtime/subsystems/jobs/job-run-service.protocol.ts` | create | `IJobRunService` with scope query methods |
| `runtime/subsystems/jobs/job-step-service.protocol.ts` | create | `IJobStepService` with step record and fetch |
| `runtime/subsystems/jobs/job-handler.base.ts` | create | `JobHandlerBase`, `JobContext<TInput>`, `@JobHandler` decorator, `ParentClosePolicy` enum, handler metadata types |
| `runtime/subsystems/jobs/jobs-domain.tokens.ts` | create | `JOB_ORCHESTRATOR`, `JOB_RUN_SERVICE`, `JOB_STEP_SERVICE` Symbol tokens |
| `runtime/subsystems/jobs/index.ts` | modify | Re-export all new types; existing JOB-1 exports preserved |

## Interfaces

### `job-orchestrator.protocol.ts`

```typescript
import type { JobRunRow } from './job-orchestration.schema';   // from JOB-1

export type JobRun = JobRunRow;

export interface StartOptions {
  scope?: { entityType: string; entityId: string };
  pool?: string;
  runAt?: Date;
  priority?: number;
  tags?: Record<string, string>;
  triggerSource?: 'manual' | 'schedule' | 'event' | 'parent';
  triggerRef?: string;
  parentClosePolicy?: ParentClosePolicy;
  parentRunId?: string;  // internal; set by spawnChild
}

export interface CancelOptions {
  cascade?: boolean;   // default true for root cancellation
  reason?: string;
}

export interface IJobOrchestrator {
  start(type: string, input: unknown, opts?: StartOptions): Promise<JobRun>;
  cancel(runId: string, opts?: CancelOptions): Promise<void>;
  replay(runId: string): Promise<JobRun>;
}
```

### `job-run-service.protocol.ts`

```typescript
import type { JobRun } from './job-orchestrator.protocol';

export interface ListForScopeOptions {
  status?: JobRun['status'] | JobRun['status'][];
  jobType?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'created_at desc' | 'created_at asc' | 'run_at desc' | 'run_at asc';
}

export interface IJobRunService {
  listForScope(entityType: string, entityId: string, opts?: ListForScopeOptions): Promise<JobRun[]>;
  cancelForScope(entityType: string, entityId: string): Promise<void>;
  rescheduleForScope(entityType: string, entityId: string, newRunAt: Date): Promise<void>;
}
```

### `job-step-service.protocol.ts`

```typescript
import type { JobStepRow } from './job-orchestration.schema';

export type JobStep = JobStepRow;

export interface RecordStepInput {
  jobRunId: string;
  stepId: string;
  kind: 'task';   // widened in ADR-027
  seq: number;
  input?: unknown;
  output?: unknown;
  error?: { message: string; stack?: string; retryable: boolean; attempt: number };
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: Date;
  finishedAt?: Date;
  attempts?: number;
}

export interface IJobStepService {
  recordStep(input: RecordStepInput): Promise<JobStep>;
  findStep(runId: string, stepId: string): Promise<JobStep | null>;
}
```

### `job-handler.base.ts`

```typescript
import type { Logger } from '@nestjs/common';
import type { JobRun } from './job-orchestrator.protocol';

export enum ParentClosePolicy {
  Terminate = 'terminate',
  Cancel = 'cancel',
  Abandon = 'abandon',
}

export interface RetryPolicy {
  attempts: number;
  backoff: 'fixed' | 'exponential';
  baseMs: number;
  nonRetryableErrors?: string[];
}

export interface ConcurrencyPolicy<TInput> {
  key: (input: TInput) => string;
  collisionMode: 'queue' | 'reject' | 'replace';
}

export interface DedupePolicy<TInput> {
  key: (input: TInput) => string;
  windowMs: number;
}

export interface ScopeRef<TInput, TScope extends string = string> {
  entity: TScope;
  from: (input: TInput) => string;
}

export interface JobHandlerMeta<TInput> {
  pool?: string;
  scope?: ScopeRef<TInput>;
  retry?: RetryPolicy;
  concurrency?: ConcurrencyPolicy<TInput>;
  dedupe?: DedupePolicy<TInput>;
  timeoutMs?: number;
  replayFrom?: 'scratch' | 'last_step' | 'last_checkpoint';
}

export interface StepOptions {
  retry?: RetryPolicy;
  timeoutMs?: number;
}

export interface SpawnChildOptions {
  closePolicy?: ParentClosePolicy;
  runAt?: Date;
  priority?: number;
  tags?: Record<string, string>;
}

export interface JobContext<TInput> {
  readonly input: TInput;
  readonly run: JobRun;
  step<TOutput>(
    stepId: string,
    fn: () => Promise<TOutput>,
    opts?: StepOptions,
  ): Promise<TOutput>;
  spawnChild(type: string, input: unknown, opts?: SpawnChildOptions): Promise<JobRun>;
  readonly logger: Logger;
  // NOT in Phase 1 — deferred to ADR-025:
  //   waitFor(kind, token, opts)
  //   signal(token, payload)
  //   sleep(ms)
}

export abstract class JobHandlerBase<TInput, TOutput = unknown> {
  abstract run(ctx: JobContext<TInput>): Promise<TOutput>;
}

export const JOB_HANDLER_REGISTRY = new Map<string, {
  type: string;
  meta: JobHandlerMeta<unknown>;
  handlerClass: new (...args: unknown[]) => JobHandlerBase<unknown>;
}>();

export const JOB_HANDLER_METADATA_KEY = Symbol('JobHandlerMeta');

export function JobHandler<TInput>(
  type: string,
  meta: JobHandlerMeta<TInput>,
): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(JOB_HANDLER_METADATA_KEY, { type, meta }, target);
    JOB_HANDLER_REGISTRY.set(type, {
      type,
      meta: meta as JobHandlerMeta<unknown>,
      handlerClass: target as unknown as new (...args: unknown[]) => JobHandlerBase<unknown>,
    });
  };
}
```

### `jobs-domain.tokens.ts`

```typescript
export const JOB_ORCHESTRATOR = Symbol('JOB_ORCHESTRATOR');
export const JOB_RUN_SERVICE  = Symbol('JOB_RUN_SERVICE');
export const JOB_STEP_SERVICE = Symbol('JOB_STEP_SERVICE');
```

## Implementation Steps

1. Create `jobs-domain.tokens.ts` (no deps).
2. Create `job-orchestrator.protocol.ts` (imports `JobRunRow` from JOB-1).
3. Create `job-run-service.protocol.ts` (imports `JobRun` from step 2).
4. Create `job-step-service.protocol.ts` (imports `JobStepRow` from JOB-1).
5. Create `job-handler.base.ts` — full file; ensure `JOB_HANDLER_REGISTRY` is module-singleton (no circular imports).
6. Update `runtime/subsystems/jobs/index.ts` — re-export new values with `export` and types with `export type`. Existing JOB-1 schema exports preserved.

## Testing Strategy

JOB-2 ships no runtime logic, only types and the decorator registry. Tests are compile-check and decorator-registration tests; no Docker required.

**Compile-check test (`__tests__/job-handler.base.types.test.ts`):** A decorated `OnboardingHandler extends JobHandlerBase<OnboardingInput, OnboardingOutput>` compiles without any cast inside `run(ctx)`. Type-level assertions validate generic flow.

**Registry test (`__tests__/job-handler.registry.test.ts`):** Import a decorated class; assert `JOB_HANDLER_REGISTRY.get('onboarding')` is populated with correct `handlerClass` and `meta`. A second handler type registers independently. Same-type double-registration overwrites (last-wins) and emits a warning log outside test env.

**Token test (`__tests__/jobs-domain.tokens.test.ts`):** All three tokens are `Symbol` and distinguishable from each other.

All three test files run under `just test-unit`.

## Acceptance Criteria (Elaborated)

- [ ] `IJobOrchestrator` has exactly `start`, `cancel`, `replay`. `start` returns `Promise<JobRun>` (not `Promise<string>`).
- [ ] `IJobRunService` has exactly `listForScope`, `cancelForScope`, `rescheduleForScope`.
- [ ] `IJobStepService` has exactly `recordStep` and `findStep`.
- [ ] `ParentClosePolicy` enum: `Terminate | Cancel | Abandon`.
- [ ] `@JobHandler<OnboardingInput>('onboarding', meta)` on a class extending `JobHandlerBase<OnboardingInput>` compiles; `ctx.input` is `OnboardingInput` without a cast.
- [ ] `JobContext` does NOT have `waitFor`, `signal`, or `sleep`; comment in file notes this.
- [ ] All three domain tokens are `Symbol` values, each distinct from the others.
- [ ] `index.ts` re-exports new symbols without removing existing JOB-1 schema exports.

## Open Questions (with proposed resolutions)

- [x] **OQ-1 — `ScopeRef.entity` type.** **Resolved 2026-04-20: shipped with the parameterised signature `ScopeRef<TInput, TScope extends string = string>`.** Default widens to `string`; JOB-7 narrows `TScope` to the generated `ScopeEntityType` union at the call site without modifying this file.

- [ ] **OQ-2 — `ScopeEntityType` union file location (ADR-022 Open Question #5).** Proposed: emit to `src/shared/jobs/scope-entity-type.ts` in the consumer project. Reasoning: (a) generated, not runtime; (b) `src/shared/` already holds generated cross-cutting types; (c) short, predictable import path `@shared/jobs/scope-entity-type`. Must be confirmed before JOB-7 templates.

- [x] **OQ-3 — `JOB_HANDLER_REGISTRY` duplicate-type warning.** **Resolved 2026-04-18: warn in dev, silent in test, throw in production.** Tests intentionally re-register; dev needs visibility; production silent-overwrite is a critical correctness bug. Three-line guard at the decorator's overwrite site.

- [x] **OQ-4 — `Logger` import coupling.** **Deferred 2026-04-18.** Use `@nestjs/common Logger` for now. A swappable `ILogger` subsystem (Protocol → Backend → Factory matching events/jobs/cache/storage) is tracked as future work — likely ADR-028 (Logging Subsystem). Add a `// TODO(logging-subsystem): swap to ILogger once ADR-028 lands` comment at the import site so it's grep-able when revisited.

## References

- ADR-022: `docs/adrs/ADR-022-job-orchestration-domain-model.md`
- Issue breakdown: `docs/specs/ADR-022-phase-1-issues.md`
- Protocol style reference: `runtime/subsystems/events/event-bus.protocol.ts`
- Schema row types (live dependency): `runtime/subsystems/jobs/job-orchestration.schema.ts` (produced by JOB-1 — `JobRunRow`, `JobStepRow`, and enum value tuples imported by JOB-2 protocols)
