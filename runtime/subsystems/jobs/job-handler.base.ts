/**
 * Handler base class, JobContext, @JobHandler decorator, and policy types
 * for the job orchestration domain (ADR-022, JOB-2).
 *
 * User-authored jobs subclass `JobHandlerBase<TInput, TOutput>` and decorate
 * the class with `@JobHandler<TInput>('job_type', meta)`. The decorator
 *   1. stores metadata via `Reflect.defineMetadata` so Nest's reflector can
 *      pick it up at module boot, and
 *   2. populates `JOB_HANDLER_REGISTRY` — a module-singleton map consumed by
 *      `JobWorkerModule` (JOB-5) to materialise `job` rows and resolve
 *      handler classes during claim/execute.
 *
 * No runtime orchestration lives here; this file is a pure type + decorator
 * surface so downstream PRs (JOB-3..JOB-5) can implement against a stable
 * shape.
 */
// TODO(logging-subsystem): swap to ILogger once ADR-028 lands
import type { Logger } from '@nestjs/common';
import { tokenKey } from '../token-key';
import type { EventOfType, EventTypeName } from '../events/event-registry';
import type { JobRun } from './job-orchestrator.protocol';

// ─── ParentClosePolicy ──────────────────────────────────────────────────────

/**
 * What happens to running child runs when a parent enters a terminal state.
 * Stored on the child at spawn; changes to the parent after spawn do NOT
 * retroactively rewrite children.
 */
export enum ParentClosePolicy {
  Terminate = 'terminate',
  Cancel = 'cancel',
  Abandon = 'abandon',
}

// ─── Policy types ───────────────────────────────────────────────────────────

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

/**
 * Declarative scope reference. `TScope` is parameterised so JOB-7 can narrow
 * `entity` to the generated `ScopeEntityType` union at the call site without
 * modifying this file (OQ-1 resolution, 2026-04-20).
 */
export interface ScopeRef<TInput, TScope extends string = string> {
  entity: TScope;
  from: (input: TInput) => string;
}

/**
 * Bridge trigger authoring shape (BRIDGE-6 follow-up — BRIDGE-6 shipped the
 * generator + runtime for `@JobHandler({ triggers })` but never added the
 * authoring field to this type; the generator's tests scan source as strings,
 * so a real decorator was never compiled and the gap went uncaught).
 *
 * Declared on `@JobHandler({ triggers })`; the codegen bridge-registry
 * generator (`src/cli/shared/bridge-registry-generator.ts`) scans these from
 * source and emits `bridge/generated/registry.ts`, validating each `event`
 * against the generated `eventRegistry` at `gen-all`. The distributed union
 * narrows `map`/`when` per `event`, so callbacks are typed against the event
 * payload (ADR-023, "typed against PayloadOfType<T>").
 *
 * Typed against events' generated types — the same `import type` coupling the
 * bridge already has (erased at runtime). `jobs` must NOT import `bridge`, so
 * the post-gen `BridgeTriggerEntry` is deliberately not referenced here;
 * `triggerId`/`jobType` are computed by the generator, not authored.
 */
export type JobTrigger<TInput> = {
  [T in EventTypeName]: {
    /** Event type that fires this trigger. Validated against `eventRegistry`. */
    event: T;
    /** Maps the event to the job input. Inlined verbatim into the registry. */
    map: (event: EventOfType<T>) => TInput;
    /** Optional guard; `false` → wrapper records `status='skipped'`. */
    when?: (event: EventOfType<T>) => boolean;
  };
}[EventTypeName];

export interface JobHandlerMeta<TInput> {
  pool?: string;
  scope?: ScopeRef<TInput>;
  retry?: RetryPolicy;
  concurrency?: ConcurrencyPolicy<TInput>;
  dedupe?: DedupePolicy<TInput>;
  timeoutMs?: number;
  replayFrom?: 'scratch' | 'last_step' | 'last_checkpoint';
  /**
   * Bridge triggers (ADR-023 Tier 3). Codegen scans these into `bridgeRegistry`;
   * the framework `BridgeDeliveryHandler` starts this job per matched event.
   * Absent for jobs started directly or via `IEventFlow.publishAndStart`.
   */
  triggers?: readonly JobTrigger<TInput>[];
}

// ─── Runtime option shapes ──────────────────────────────────────────────────

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

// ─── JobContext ─────────────────────────────────────────────────────────────

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

// ─── JobHandlerBase ─────────────────────────────────────────────────────────

export abstract class JobHandlerBase<TInput, TOutput = unknown> {
  abstract run(ctx: JobContext<TInput>): Promise<TOutput>;
}

// ─── Registry + decorator ───────────────────────────────────────────────────

/**
 * Module-singleton map keyed by job type. Populated by the `@JobHandler`
 * decorator at class definition time; consumed by `JobWorkerModule` (JOB-5)
 * to upsert `job` rows and resolve handler classes during claim/execute.
 */
export const JOB_HANDLER_REGISTRY = new Map<
  string,
  {
    type: string;
    meta: JobHandlerMeta<unknown>;
    handlerClass: new (...args: unknown[]) => JobHandlerBase<unknown>;
  }
>();

// ADR-037: namespaced `Symbol.for(...)` (via `tokenKey()`) so the reflection-metadata
// key matches by value across import boundaries (the @JobHandler decorator and the
// reader may resolve different runtime copies). Distinct from the DI tokens but
// subject to the same dual-package identity hazard.
export const JOB_HANDLER_METADATA_KEY = Symbol.for(tokenKey('jobs', 'handler-metadata'));

/**
 * Class decorator that registers a handler with the job type, the full
 * metadata shape, and the target class constructor.
 *
 * Duplicate-type behaviour (OQ-3, resolved 2026-04-18):
 *   - `NODE_ENV === 'production'` → throw; silent overwrite in prod is a
 *     correctness bug.
 *   - `NODE_ENV === 'test'`       → silent overwrite (tests intentionally
 *     re-register handlers).
 *   - otherwise (dev)             → `console.warn` + overwrite. `console`
 *     is used intentionally instead of the Nest `Logger` — decorators run
 *     at module-load time before any Nest container exists.
 */
export function JobHandler<TInput>(
  type: string,
  meta: JobHandlerMeta<TInput>,
): ClassDecorator {
  return (target) => {
    if (JOB_HANDLER_REGISTRY.has(type)) {
      const env = process.env.NODE_ENV;
      if (env === 'production') {
        throw new Error(
          `[JobHandler] Duplicate registration for job type '${type}'. ` +
            `Each @JobHandler must declare a unique type.`,
        );
      }
      if (env !== 'test') {
        // eslint-disable-next-line no-console
        console.warn(
          `[JobHandler] Duplicate registration for job type '${type}'. ` +
            `Overwriting previous handler — this is almost certainly a bug.`,
        );
      }
    }

    Reflect.defineMetadata(JOB_HANDLER_METADATA_KEY, { type, meta }, target);
    JOB_HANDLER_REGISTRY.set(type, {
      type,
      meta: meta as JobHandlerMeta<unknown>,
      handlerClass: target as unknown as new (
        ...args: unknown[]
      ) => JobHandlerBase<unknown>,
    });
  };
}

// ─── HandlerRegistry — read helpers consumed by JobWorkerModule (JOB-5) ─────

/**
 * Single entry shape returned by `HandlerRegistry.getAll()` / `.get()` and
 * exposed to `JobWorkerModule.onModuleInit` for boot-time upserts.
 *
 * Structurally compatible with `IJobOrchestrator.upsertJobRows`'s
 * `JobUpsertEntry` so the worker module can pass entries through verbatim
 * without re-mapping.
 */
export interface HandlerRegistryEntry {
  type: string;
  meta: JobHandlerMeta<unknown>;
  handlerClass: new (...args: unknown[]) => JobHandlerBase<unknown>;
}

/**
 * Read facade over `JOB_HANDLER_REGISTRY`. The decorator's write path is
 * unchanged; this namespace exists so consumers (the worker module, tests)
 * don't import the raw `Map` and accidentally mutate it.
 */
export namespace HandlerRegistry {
  /** All registered entries in insertion order. */
  export function getAll(): HandlerRegistryEntry[] {
    return Array.from(JOB_HANDLER_REGISTRY.values());
  }

  /** Lookup by job type, or `undefined` if no `@JobHandler` is registered. */
  export function get(type: string): HandlerRegistryEntry | undefined {
    return JOB_HANDLER_REGISTRY.get(type);
  }
}
