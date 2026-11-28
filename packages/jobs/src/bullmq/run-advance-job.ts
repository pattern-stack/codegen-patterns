import { advanceRun } from '../engine/advance-run.ts';
import { inScope } from '../ports/run-scope.ts';
import type { AdvanceJobData } from './job-data.ts';
import type { JobEngineRuntime } from './runtime.ts';

/**
 * The worker side of an advance: one run's step loop (`advanceRun`), then its pending chunks dispatched. A map step's
 * planning dispatches as it pages (one dispatch in flight at a time), so a long source starts its first chunks early.
 */
export async function runAdvanceJob(
  rt: JobEngineRuntime,
  data: AdvanceJobData,
  carried: unknown,
): Promise<'advanced'> {
  let inFlight: Promise<void> | null = null;
  let again = false;
  const dispatchSoon = () => {
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = (async () => {
      do {
        again = false;
        await rt.dispatch(data.runId, carried);
      } while (again);
    })()
      .catch((err: unknown) => rt.report(err))
      .finally(() => {
        inFlight = null;
      });
  };
  const run = await rt.store.getRun(data.runId);
  await inScope(rt.around, { runId: run.id, tenantId: run.tenantId, jobKey: run.jobKey }, () =>
    advanceRun(
    {
      store: rt.store,
      registry: rt.registry,
      clock: rt.clock,
      events: rt.events,
      signal: rt.signal,
      limiters: rt.limiters,
      stops: rt.stops,
      pageSize: rt.pageSize,
      versionGone: (run) => rt.versionGone(run),
      // Every run is its own trace root: a child's advance carries none of its parent's.
      submit: (id) => rt.enqueueAdvance(id, undefined),
      onChange: dispatchSoon,
    },
    data.runId,
  ),
  );
  await inFlight;
  await rt.dispatch(data.runId, carried);
  return 'advanced';
}
