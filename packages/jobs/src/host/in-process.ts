import { InProcessExecutor, type InProcessOptions } from '../adapters/in-process-executor.ts';
import { localLimiters } from '../adapters/local-limiter.ts';
import { logSink } from '../adapters/log-sink.ts';
import type { Registry } from '../define/registry.ts';
import { eventLogSink } from '../postgres/event-log-sink.ts';
import type { PostgresJobStore } from '../postgres/postgres-job-store.ts';
import type { JobStore } from '../ports/job-store.ts';
import type { EventSink } from '../ports/event-sink.ts';
import type { LimiterConfig, Limiters } from '../ports/limiter.ts';
import type { RunScope } from '../ports/run-scope.ts';
import { assertLimitersConfigured } from './limiters.ts';
import { activeSpanSink } from './sinks.ts';

/**
 * The in-process engine as every host builds it, the one builder (codegen J-1): the Nest `JobsModule`'s in-process
 * providers and a plain host's engine (`@pattern-stack/wiring`, codegen's `createJobsEngine`) both call these, so a
 * sink, a limiter rule or an executor default changes for both.
 */

/** The in-process executor's knobs a host may set (poll, open-run sweep, lease, drain window): the rest is built. */
export type InProcessKnobs = Omit<InProcessOptions, 'store' | 'registry' | 'limiters' | 'sinks' | 'around' | 'clock'>;

/** A store the engine runs over: any `JobStore` that keeps the event log (`PostgresJobStore`, or a test's). */
export type EngineStore = JobStore & Pick<PostgresJobStore, 'appendEvent'>;

/** The engine's sinks, in order: the active span, one log line per event (`log`), the store's event log, the host's. */
export function engineSinks(
  store: Pick<EngineStore, 'appendEvent'>,
  log: (line: string) => void,
  host: readonly EventSink[] = [],
): EventSink[] {
  return [activeSpanSink(), logSink(log), eventLogSink(store), ...host];
}

/** In-memory limiters, after the boot check: a registered job naming a limiter with no config stops the boot. */
export function inProcessLimiters(registry: Registry, config: Readonly<Record<string, LimiterConfig>>): Limiters {
  assertLimitersConfigured(registry, config);
  return localLimiters(config);
}

/** The in-process executor over the built parts and the host's knobs; every call into job code inside `around`. */
export function inProcessExecutor(parts: {
  store: JobStore;
  registry: Registry;
  sinks: readonly EventSink[];
  limiters: Limiters;
  around?: RunScope;
  knobs?: InProcessKnobs;
}): InProcessExecutor {
  return new InProcessExecutor({
    ...parts.knobs,
    store: parts.store,
    registry: parts.registry,
    sinks: [...parts.sinks],
    limiters: parts.limiters,
    ...(parts.around ? { around: parts.around } : {}),
  });
}
