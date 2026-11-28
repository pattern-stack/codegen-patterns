import type { AnyJob } from '../define/define-job.ts';
import type { Registry } from '../define/registry.ts';
import { startRun } from '../engine/start-run.ts';
import type { Budget, Run, RunRequest } from '../model/run.ts';
import type { Clock } from '../ports/clock.ts';
import type { EventSink } from '../ports/event-sink.ts';
import type { Executor } from '../ports/executor.ts';
import type { JobStore } from '../ports/job-store.ts';
import type { RunScope } from '../ports/run-scope.ts';
import { type AskedBudget, resolveBudget } from './budget.ts';

/** What a host's system start runs over: the engine's parts, whether this process is a worker, where it warns. */
export interface SystemStartParts {
  registry: Registry;
  store: JobStore;
  executor: Pick<Executor, 'submit'>;
  clock: Clock;
  events: EventSink;
  around?: RunScope;
  /** `false` in a process that runs no executor loop: it never submits, so no job code runs there without a lease. */
  worker?: boolean;
  /** Where a failed submit is said. */
  warn: (message: string) => void;
}

/** A system start: a run request whose budget is asked (an omitted field is the job's limit). */
export type SystemStartRequest = Omit<RunRequest<unknown>, 'budget'> & { budget?: AskedBudget };

/**
 * Submits a run to this process's executor, the one rule every host start follows: a process that is no worker never
 * submits (the worker's open-run sweep takes the run), and a failed submit is said, never thrown (the run exists; the
 * sweep resubmits it).
 */
export async function submitRun(parts: Pick<SystemStartParts, 'executor' | 'worker' | 'warn'>, runId: string): Promise<void> {
  if (parts.worker === false) return;
  try {
    await parts.executor.submit(runId);
  } catch (err) {
    parts.warn(
      `job run ${runId} was not submitted (${err instanceof Error ? err.name : typeof err}); the sweep resubmits it`,
    );
  }
}

/**
 * The system start, framework-free (codegen J-1): any registered job, in the request's tenant, with no audience,
 * authority or limit ceiling (the caller applied its own). The budget is the job's limits unless the request names one
 * (`resolveBudget`, or a host's mapping of its refusals, `budget`); the job's `admit` runs, and the engine's refusals
 * are thrown as they are. Then the run is submitted (`submitRun`), unless it was made in `inStore`, a store bound to
 * the caller's transaction: no other connection sees it before the commit, and the sweep finds it after. A dedupe
 * incumbent is submitted again too: deduplicated, so harmless. The Nest `JobsService.startSystemRun` and a plain
 * host's starter are both this.
 */
export async function startSystemRun(
  parts: SystemStartParts,
  request: SystemStartRequest,
  options: {
    inStore?: JobStore;
    budget?: (job: AnyJob, asked: AskedBudget | undefined, now: Date) => Budget;
  } = {},
): Promise<{ run: Run; created: boolean }> {
  const job = parts.registry.get(request.jobKey);
  const budget = options.budget ?? ((j, asked, now) => resolveBudget(j, asked, { now, ceiling: false }));
  const started = await startRun(
    {
      registry: parts.registry,
      store: options.inStore ?? parts.store,
      around: parts.around,
      clock: parts.clock,
      events: parts.events,
    },
    { ...request, budget: budget(job, request.budget, parts.clock.now()) },
  );
  if (!options.inStore) await submitRun(parts, started.run.id);
  return started;
}
