import type { Registry } from '../../index.ts';
import type { Clock, EventSink, Executor, JobStore } from '../../ports.ts';
import type { JobOperatorReads } from '../../postgres.ts';
import { JobInputRefRegistry, type JobInputRefs } from '../job-input-refs.ts';
import { JobsService } from '../jobs.service.ts';
import { publicJobCatalogOf } from '../public-job-catalog.ts';
import type { JobsTenants } from '../tokens.ts';

/** The operator reads a test gives; any other read it makes is a failure. */
export function readsOf(
  given: Partial<JobOperatorReads> = {},
): JobOperatorReads {
  return new Proxy(given as JobOperatorReads, {
    get: (target, name) =>
      Reflect.get(target, name) ??
      (() => {
        throw new Error(`an unexpected operator read: ${String(name)}`);
      }),
  });
}

/** The one `JobsService`, built directly as the specs build it: what a test leaves out answers nothing. */
export function jobsServiceOf(deps: {
  registry: Registry;
  store: JobStore;
  executor: Executor;
  clock: Clock;
  events: EventSink;
  reads?: JobOperatorReads;
  tenants?: JobsTenants;
  refs?: JobInputRefs;
  /** `false`: a process that runs no executor loop (it starts runs, a worker advances them). */
  worker?: boolean;
}): JobsService {
  return new JobsService(
    deps.registry,
    deps.store,
    deps.reads ?? readsOf(),
    deps.executor,
    deps.clock,
    deps.events,
    publicJobCatalogOf(deps.registry),
    deps.tenants ?? { findById: async () => null },
    deps.refs ?? new JobInputRefRegistry(),
    undefined,
    deps.worker,
  );
}
