/**
 * `@pattern-stack/jobs` on the app's Postgres, run in process, with no framework (J-1): the same engine the package's
 * Nest `JobsModule` builds, from the same builder (`@pattern-stack/jobs/host`: the sinks, the checked limiters, the
 * executor) and the same knobs (`IN_PROCESS_DEFAULTS`). The `jobs` system of a pattern-stack app calls it
 * (`<generated>/jobs-system.ts`); the Nest host is `JobsEngineModule`.
 *
 * - The registry: each `jobFactory` built with lazy dependencies, whose values the composition hands over per factory
 *   (`provide`, from the generated `jobDeps` module). A factory's dependencies are composition parts; there is no
 *   container to look a token up in.
 * - The Postgres store over the app's Drizzle client and the package's tables; the sinks (the active span, one log
 *   line per event through the logger port, the store's event log); the in-memory limiters, checked against the
 *   registry; the `InProcessExecutor`, every call into job code inside `tenantRunScope`; and a `JobRunStarter`.
 * - `start()` first checks that every factory's dependencies were provided (compose does not stop a part whose start
 *   failed, so nothing is started before the check), then starts the executor's loop when this process is a worker.
 *   `stop()` stops the loop and lets in-flight work settle; it is idempotent.
 */
import {
  type AnyJob,
  assertResolvable,
  buildJobs,
  createRegistry,
  type InProcessExecutor,
  type JobEntry,
  type JobFactory,
  type Registry,
  systemClock,
} from '@pattern-stack/jobs';
import { type EngineStore, engineSinks, fanOutSinks, inProcessExecutor, inProcessLimiters } from '@pattern-stack/jobs/host';
import type { LimiterConfig } from '@pattern-stack/jobs/ports';
import { type JobDatabase, jobTables, PostgresJobStore } from '@pattern-stack/jobs/postgres';

import { createLogger } from '../../logger';
import { IN_PROCESS_DEFAULTS, type InProcessKnobs } from './in-process-defaults';
import { JobRunStarter } from './job-run-starter';
import { tenantRunScope } from './tenant-run-scope';

export interface CreateJobsEngineOptions {
  /** The app's Drizzle client: the store reads and writes the package's tables through it. */
  db: unknown;
  /** Every job this app runs: the generated `jobDefinitions`. */
  definitions: readonly JobEntry[];
  /** Start the executor's loop in this process (`JOBS_WORKER`). */
  worker: boolean;
  /** The pools: each limiter a step names, by name. */
  limiters?: Readonly<Record<string, LimiterConfig>>;
  /** The store, when not the Postgres store over `db` (a test's: any `JobStore` that keeps the event log). */
  store?: EngineStore;
  /** The in-process executor's knobs (poll, open-run sweep, lease, drain window), over `IN_PROCESS_DEFAULTS`. */
  inProcess?: InProcessKnobs;
}

export interface JobsEngine {
  /** How app code, and the bridge, start a run. */
  readonly starter: JobRunStarter;
  readonly registry: Registry;
  readonly store: EngineStore;
  readonly executor: InProcessExecutor;
  /** Whether this process runs the executor's loop. */
  readonly worker: boolean;
  /** The values of one factory's dependencies, typed by the factory: a wrong part does not compile. */
  provide<D extends Record<string, unknown>>(factory: JobFactory<D>, values: D): void;
  /** Checks every factory's dependencies were provided, then starts the loop (a worker). */
  start(): Promise<void>;
  /** Stops the loop; in-flight work settles. Stopping what isn't started, or twice, does nothing. */
  stop(): Promise<void>;
}

export function createJobsEngine(options: CreateJobsEngineOptions): JobsEngine {
  const logger = createLogger('JobEngine');
  const provided = new Map<JobFactory, Readonly<Record<string, unknown>>>();
  const resolve = (_token: unknown, at: { entry: JobFactory; name: string }): unknown => {
    const values = provided.get(at.entry);
    if (!values || !Object.hasOwn(values, at.name)) {
      throw new Error(`no value was provided for it (the generated jobDeps module provides each factory's dependencies)`);
    }
    return values[at.name];
  };
  const jobs: AnyJob[] = buildJobs(options.definitions, resolve);
  const registry = createRegistry(jobs);
  const store = options.store ?? new PostgresJobStore(options.db as JobDatabase, jobTables);
  const sinks = engineSinks(store, (line) => logger.log(line));
  const events = fanOutSinks(sinks, (message) => logger.warn(message));
  const executor = inProcessExecutor({
    store,
    registry,
    sinks,
    limiters: inProcessLimiters(registry, options.limiters ?? {}),
    around: tenantRunScope,
    knobs: { ...IN_PROCESS_DEFAULTS, ...options.inProcess },
  });
  const starter = new JobRunStarter({
    registry,
    store,
    executor,
    tables: jobTables,
    clock: systemClock,
    events,
    around: tenantRunScope,
    worker: options.worker,
  });

  let started = false;
  return {
    starter,
    registry,
    store,
    executor,
    worker: options.worker,
    provide(factory, values) {
      if (!options.definitions.some((e) => e === factory)) {
        throw new Error('jobs: provide() was given a job factory this app does not list in its job definitions');
      }
      provided.set(factory as unknown as JobFactory, values);
    },
    async start() {
      assertResolvable(options.definitions, jobs, resolve);
      if (!options.worker || started) return;
      await executor.start();
      started = true;
    },
    async stop() {
      if (!started) return;
      started = false;
      await executor.stop();
    },
  };
}

