/**
 * BullMQ backend configuration surface (BULLMQ-1, ADR-022 extension slot).
 *
 * The core `IJobOrchestrator` contract is backend-agnostic; everything in
 * this file is BullMQ-specific and lives behind the
 * `jobs.extensions.bullmq.*` config namespace (CLAUDE.md core/extension
 * protocol). The Drizzle backend never reads any of it.
 */
import type { ConnectionOptions } from 'bullmq';
import { loadPoolConfig, type PoolConfig } from './pool-config.loader';

/**
 * Typed shape of `codegen.config.yaml: jobs.extensions.bullmq`. Snake_case
 * because it mirrors the YAML the consumer authors.
 *
 * ```yaml
 * jobs:
 *   backend: bullmq
 *   extensions:
 *     bullmq:
 *       redis_url: redis://localhost:6379   # or env REDIS_URL
 *       queue_prefix: myapp                  # optional namespace (ADR-022 OQ)
 *       bull_board:
 *         enabled: true
 *         mount_path: /api/admin/queues
 * ```
 */
export interface BullMqExtensionsConfig {
  /**
   * Redis/Valkey connection URL. When omitted, the runtime resolves
   * `process.env.REDIS_URL`, then falls back to `redis://localhost:6379`.
   */
  redis_url?: string;
  /**
   * Optional queue-name prefix to avoid collisions when several codegen apps
   * share one Redis (ADR-022 §"BullMQ queue naming collisions"). Applied to
   * every pool queue alias.
   */
  queue_prefix?: string;
  /**
   * Bull Board dashboard — opt-in extension (not core). Mounting is the
   * consumer's responsibility (it needs the consumer's Express/Nest adapter +
   * admin auth); we only carry the config. See README + spec §Extensions.
   */
  bull_board?: {
    enabled: boolean;
    mount_path?: string;
  };
}

/**
 * The runtime form after `redis_url`/env resolution. This is what the
 * orchestrator + worker actually consume.
 */
export interface BullMqResolvedConfig {
  connection: ConnectionOptions;
  queuePrefix?: string;
  bullBoard?: { enabled: boolean; mountPath: string };
}

/** DI token for the resolved BullMQ `ConnectionOptions` (ioredis-compatible). */
export const BULLMQ_CONNECTION = Symbol('BULLMQ_CONNECTION');

/** DI token for the full resolved BullMQ config (prefix + bull board). */
export const BULLMQ_RESOLVED_CONFIG = Symbol('BULLMQ_RESOLVED_CONFIG');

const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const DEFAULT_BULL_BOARD_MOUNT = '/admin/queues';

/**
 * Resolve the BullMQ runtime config from the extension block.
 *
 * Precedence for the connection URL:
 *   1. explicit `extensions.bullmq.redis_url`
 *   2. `process.env.REDIS_URL`
 *   3. `redis://localhost:6379`
 *
 * Returns a `{ url }` connection shape — BullMQ/ioredis accept a URL string
 * via the `{ url }` ConnectionOptions form.
 */
export function resolveBullMqConfig(
  ext: BullMqExtensionsConfig | undefined,
): BullMqResolvedConfig {
  const url =
    ext?.redis_url ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;

  const resolved: BullMqResolvedConfig = {
    connection: { url } as ConnectionOptions,
    queuePrefix: ext?.queue_prefix,
  };
  if (ext?.bull_board?.enabled) {
    resolved.bullBoard = {
      enabled: true,
      mountPath: ext.bull_board.mount_path ?? DEFAULT_BULL_BOARD_MOUNT,
    };
  }
  return resolved;
}

/**
 * Resolve the BullMQ queue name for a *logical pool name*. The orchestrator
 * and worker MUST agree on this mapping or jobs are enqueued onto a queue
 * nobody consumes. Both derive it identically:
 *
 *   1. Look up the pool's `queue` alias (e.g. `jobs-batch`) in the resolved
 *      pool config — the same alias `JobWorkerModule.onModuleInit` logs and
 *      that the BullMQ `Worker` binds to.
 *   2. Fall back to the logical pool name when the pool is unknown (defensive;
 *      still a stable, colon-free identifier).
 *   3. Apply the optional `queue_prefix` namespace for multi-app Redis
 *      sharing — `:` is fine in the *queue name* (it is only forbidden in the
 *      `jobId`, hence the sha1 there).
 *
 * `poolConfig` defaults to the cached `loadPoolConfig()` so callers that only
 * hold the logical pool name (the orchestrator) don't need to thread the map.
 */
export function resolvePoolQueueName(
  pool: string,
  config: BullMqResolvedConfig | null | undefined,
  poolConfig: PoolConfig = loadPoolConfig(),
): string {
  const alias = poolConfig.get(pool)?.queue ?? pool;
  const prefix = config?.queuePrefix;
  return prefix ? `${prefix}:${alias}` : alias;
}
