/**
 * Pool config for the job orchestration domain (ADR-022, JOB-5; CFG-1).
 *
 * The consumer's `codegen.config.yaml: jobs.pools` is a generation-time fact
 * (CFG-1, #643): the generator validates it and writes it into
 * `<generated>/app-config.ts` as `jobPools`, and the generated wiring passes it
 * to `JobsDomainModule.forRoot({ pools })` / `JobWorkerModule.forRoot({
 * domainModulePools })`. Nothing in the app reads the YAML. This module holds
 * the pool rules — once — and the pure merge:
 *
 *   - `poolOverrideIssues` states the rules. The config schema runs it at
 *     generation (`jobs.pools` `superRefine`), so a bad pool is a
 *     `CodegenConfigError` naming the key before any code is written.
 *   - `resolvePoolConfig` merges the overrides onto the five framework pools
 *     and throws on the same issues for a programmatic caller.
 *
 * Rules:
 *   - A framework pool may tune `concurrency` + `description`; its `queue` and
 *     `reserved` are part of the cross-subsystem contract with the events
 *     outbox drain and cannot be set.
 *   - A user-defined pool needs a non-empty `queue` and a positive
 *     `concurrency`, and cannot set `reserved: true` — reserved is
 *     framework-only.
 *
 * Pure: no Nest, no fs. The config schema imports it.
 */

export interface PoolDefinition {
  /** Routing identifier — reused as the per-pool worker queue name. */
  queue: string;
  /** Max parallel in-flight `processRun` calls for this pool's worker. */
  concurrency: number;
  /** `true` ⇒ user `@JobHandler` may not target it. Framework-only. */
  reserved: boolean;
  /** Free-text annotation surfaced in admin UIs / logs. */
  description?: string;
}

/** One `jobs.pools.<name>` entry as the generator emits it. */
export interface PoolOverride {
  readonly queue?: string;
  readonly concurrency?: number;
  readonly reserved?: boolean;
  readonly description?: string;
}

/** `jobs.pools`, keyed by pool name. */
export type PoolOverrides = Readonly<Record<string, PoolOverride>>;

export type PoolConfig = Map<string, PoolDefinition>;

/**
 * Five framework defaults. Three reserved `events_*` pools drain the
 * `IEventBus` outbox (one per `DomainEvent.direction`); `interactive` and
 * `batch` are user-default pools (`batch` is the `@JobHandler` default
 * when no `pool` is specified).
 */
export const FRAMEWORK_POOLS: Readonly<Record<string, PoolDefinition>> = Object.freeze({
  events_inbound: Object.freeze({
    queue: 'jobs-events-inbound',
    concurrency: 20,
    reserved: true,
    description: 'Inbound events drain (events subsystem outbox).',
  }),
  events_change: Object.freeze({
    queue: 'jobs-events-change',
    concurrency: 30,
    reserved: true,
    description: 'Change events drain (events subsystem outbox).',
  }),
  events_outbound: Object.freeze({
    queue: 'jobs-events-outbound',
    concurrency: 10,
    reserved: true,
    description: 'Outbound events drain (events subsystem outbox).',
  }),
  interactive: Object.freeze({
    queue: 'jobs-interactive',
    concurrency: 20,
    reserved: false,
    description: 'User-facing latency-sensitive jobs.',
  }),
  batch: Object.freeze({
    queue: 'jobs-batch',
    concurrency: 5,
    reserved: false,
    description: 'Default pool for background jobs.',
  }),
});

/** Names of the framework reserved pools. Cheap inline lookup for the worker. */
export const RESERVED_POOL_NAMES: ReadonlySet<string> = new Set(
  Object.entries(FRAMEWORK_POOLS)
    .filter(([, def]) => def.reserved)
    .map(([name]) => name),
);

/** One broken pool rule: the key path under `jobs.pools`, and why. */
export interface PoolOverrideIssue {
  path: [string, keyof PoolOverride];
  message: string;
}

/**
 * Every rule `overrides` breaks. Shape (types, unknown keys) is the schema's
 * job; these are the rules that need the framework pool table.
 */
export function poolOverrideIssues(overrides: PoolOverrides | undefined): PoolOverrideIssue[] {
  const issues: PoolOverrideIssue[] = [];
  for (const [name, def] of Object.entries(overrides ?? {})) {
    if (Object.prototype.hasOwnProperty.call(FRAMEWORK_POOLS, name)) {
      for (const key of ['queue', 'reserved'] as const) {
        if (def[key] !== undefined) {
          issues.push({
            path: [name, key],
            message: `'${name}' is a framework pool; its '${key}' is fixed (only 'concurrency' and 'description' can be set)`,
          });
        }
      }
      continue;
    }
    if (typeof def.queue !== 'string' || def.queue.length === 0) {
      issues.push({ path: [name, 'queue'], message: `user-defined pool '${name}' must declare a non-empty 'queue'` });
    }
    if (typeof def.concurrency !== 'number' || def.concurrency <= 0) {
      issues.push({
        path: [name, 'concurrency'],
        message: `user-defined pool '${name}' must declare a positive 'concurrency'`,
      });
    }
    if (def.reserved !== undefined) {
      issues.push({
        path: [name, 'reserved'],
        message: `user-defined pool '${name}' cannot set 'reserved' — reserved is framework-only`,
      });
    }
  }
  return issues;
}

/**
 * The resolved pool map: the five framework pools with `overrides` merged on.
 * Throws on any `poolOverrideIssues` — the generator has already rejected
 * them, so this fires only for a hand-written call.
 */
export function resolvePoolConfig(overrides?: PoolOverrides): PoolConfig {
  const issues = poolOverrideIssues(overrides);
  if (issues.length > 0) {
    throw new Error(
      `jobs pool config: ${issues.map((i) => `jobs.pools.${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const merged: PoolConfig = new Map();
  for (const [name, def] of Object.entries(FRAMEWORK_POOLS)) {
    merged.set(name, { ...def });
  }
  for (const [name, def] of Object.entries(overrides ?? {})) {
    const existing = merged.get(name);
    if (existing) {
      merged.set(name, {
        ...existing,
        concurrency: def.concurrency ?? existing.concurrency,
        description: def.description ?? existing.description,
      });
      continue;
    }
    merged.set(name, {
      queue: def.queue!,
      concurrency: def.concurrency!,
      reserved: false,
      description: def.description,
    });
  }
  return merged;
}

/**
 * Names of every non-reserved pool in the resolved config. The default
 * worker activation set when `JobWorkerModuleOptions.pools` is omitted —
 * the worker process never claims the reserved `events_*` pools by
 * default; those are bound by the events subsystem's outbox bridge.
 */
export function allNonReservedPoolNames(config: PoolConfig): string[] {
  const out: string[] = [];
  for (const [name, def] of config) {
    if (!def.reserved) out.push(name);
  }
  return out;
}

/**
 * Names of **every** pool in the resolved config, reserved `events_*` lanes
 * included. The activation set for a standalone worker booted with
 * `JobWorkerModule.forRoot({ allPools: true })` (BULLMQ-1 Phase 1) — the
 * single worker process drains both user pools and the bridge's reserved
 * pools so wrapper `job_run` rows are never stranded.
 */
export function allPoolNames(config: PoolConfig): string[] {
  return [...config.keys()];
}
