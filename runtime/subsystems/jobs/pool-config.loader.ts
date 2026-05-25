/**
 * Pool config loader for the job orchestration domain (ADR-022, JOB-5).
 *
 * Reads `codegen.config.yaml: jobs.pools` from `process.cwd()` (or an
 * explicit `configPath` for tests), merges user-defined pools onto the five
 * framework defaults, and returns the resolved `Map<string, PoolDefinition>`
 * consumed by `JobWorkerModule.onModuleInit` and `JobsDomainModule`'s
 * config-validator surface.
 *
 * Invariants:
 *   - User cannot flip `reserved: true` on a framework pool — silently
 *     preserved. The three `events_*` pools are reserved infrastructure
 *     for the events outbox drain.
 *   - User-defined pools cannot set `reserved: true` — `reserved` is
 *     framework-only metadata.
 *   - Missing `codegen.config.yaml` is not an error; loader returns the
 *     framework defaults verbatim.
 *
 * Result is cached at module scope after first call so repeated reads (e.g.
 * a worker module + a one-off scaffold validator in the same process) hit
 * the same parse. Tests that pass `configPath` skip the cache and isolate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

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

/**
 * Cache by absolute config path. The `cwd` default is normalised before
 * lookup so two callers passing the same path share the cache; explicit
 * test-only paths cache separately.
 */
const cache = new Map<string, PoolConfig>();

/**
 * Reset the loader cache. Test-only — not exported from the package
 * `index.ts`. Useful for tests that mutate `process.cwd()` between cases.
 */
export function _resetPoolConfigCacheForTests(): void {
  cache.clear();
}

/**
 * Resolve the merged pool config.
 *
 * @param configPath optional absolute or cwd-relative path; defaults to
 *                   `${process.cwd()}/codegen.config.yaml`.
 */
export function loadPoolConfig(configPath?: string): PoolConfig {
  const resolved = resolve(configPath ?? `${process.cwd()}/codegen.config.yaml`);
  const cached = cache.get(resolved);
  if (cached) return cached;

  const merged = new Map<string, PoolDefinition>();
  // Seed with framework defaults first — they always take precedence on
  // `reserved` and provide defaults for `queue` / `concurrency` if user
  // overrides only some fields.
  for (const [name, def] of Object.entries(FRAMEWORK_POOLS)) {
    merged.set(name, { ...def });
  }

  if (!existsSync(resolved)) {
    cache.set(resolved, merged);
    return merged;
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(
      `pool-config.loader: failed to parse YAML at ${resolved}: ${(err as Error).message}`,
    );
  }

  const userPools = extractUserPools(raw);
  for (const [name, userDef] of Object.entries(userPools)) {
    const existing = merged.get(name);
    if (existing) {
      // Framework pool — user may tweak concurrency + description but
      // cannot flip `reserved`. `queue` is frozen too (reserved framework
      // pools' queue identifiers are part of the cross-subsystem contract
      // with the events outbox drain).
      const next: PoolDefinition = {
        queue: existing.queue,
        concurrency:
          typeof userDef.concurrency === 'number'
            ? userDef.concurrency
            : existing.concurrency,
        reserved: existing.reserved,
        description: userDef.description ?? existing.description,
      };
      merged.set(name, next);
      continue;
    }
    // User-defined pool. Validate required fields; reject reserved.
    if (typeof userDef.queue !== 'string' || userDef.queue.length === 0) {
      throw new Error(
        `pool-config.loader: pool '${name}' must declare a non-empty 'queue'.`,
      );
    }
    if (typeof userDef.concurrency !== 'number' || userDef.concurrency <= 0) {
      throw new Error(
        `pool-config.loader: pool '${name}' must declare a positive 'concurrency'.`,
      );
    }
    if (userDef.reserved === true) {
      throw new Error(
        `pool-config.loader: user-defined pool '${name}' cannot set ` +
          `'reserved: true' — reserved is framework-only.`,
      );
    }
    merged.set(name, {
      queue: userDef.queue,
      concurrency: userDef.concurrency,
      reserved: false,
      description: userDef.description,
    });
  }

  cache.set(resolved, merged);
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

// ─── internals ──────────────────────────────────────────────────────────────

interface UserPoolShape {
  queue?: string;
  concurrency?: number;
  reserved?: boolean;
  description?: string;
}

function extractUserPools(raw: unknown): Record<string, UserPoolShape> {
  if (!raw || typeof raw !== 'object') return {};
  const jobs = (raw as { jobs?: unknown }).jobs;
  if (!jobs || typeof jobs !== 'object') return {};
  const pools = (jobs as { pools?: unknown }).pools;
  if (!pools || typeof pools !== 'object') return {};
  const out: Record<string, UserPoolShape> = {};
  for (const [name, def] of Object.entries(pools as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue;
    out[name] = def as UserPoolShape;
  }
  return out;
}
