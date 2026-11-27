import { assertTenant } from '../model/tenant.ts';
import { inScope, type RunScope } from '../ports/run-scope.ts';
import type { AnyJob } from '../define/define-job.ts';
import type { Registry } from '../define/registry.ts';
import {
  JobDefinitionError,
  RunPlanningError,
  RunVersionConflictError,
} from '../model/errors.ts';
import {
  ACTIVE_RUN,
  type Budget,
  COLLISIONS,
  type StoreCollision,
  RUN_SUBJECT_ID_MAX,
  RUN_SUBJECT_KIND_MAX,
  type Run,
  type RunRequest,
  type RunSubject,
} from '../model/run.ts';
import type { Clock } from '../ports/clock.ts';
import type { EventSink } from '../ports/event-sink.ts';
import type { JobStore } from '../ports/job-store.ts';
import { outputReader } from './context.ts';
import { eventBase } from './emitter.ts';
import {
  assertStoreHoldsValues,
  assertStoreSafeFor,
  inputForStore,
  recordInput,
} from './values.ts';

/**
 * Starts a run: validates the input against the job, asks the job's `admit`, then creates it, or returns the open run
 * with the same tenant, job, dry or real, and dedupe key (`created: false`): a real start is never answered by
 * an open dry run, nor the reverse. An open run made by another version of the definition is refused
 * (`RunVersionConflictError`): a run is read against the definition it ran. A refused input creates nothing and holds
 * no dedupe key.
 */
export async function startRun(
  deps: {
    registry: Registry;
    store: JobStore;
    /** Wraps `admit` in the start's scope (`RunScope`; no run yet, so `runId` null). */
    around?: RunScope;
    /** For `collision: 'replace'`: the replaced run's `run.canceled` event. */
    clock?: Clock;
    events?: EventSink;
  },
  request: RunRequest<unknown>,
): Promise<{ run: Run; created: boolean }> {
  const job = deps.registry.get(request.jobKey);
  assertTenant(request.tenantId, `${request.jobKey}: startRun`);
  const parsed = job.input.safeParse(request.input);
  if (!parsed.success)
    throw new RunPlanningError(
      `${job.key}: input refused (${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`)
        .join('; ')})`,
    );
  const admit = job.admit;
  if (admit)
    await inScope(
      deps.around,
      { runId: null, tenantId: request.tenantId, jobKey: job.key },
      () =>
        admit(parsed.data, {
          tenantId: request.tenantId,
          dryRun: request.dryRun ?? false,
          outputOf: outputReader(deps.store, request.tenantId),
        }),
    );
  assertStoreHoldsValues(job, deps.store);
  assertStoreSafeFor(job, deps.store);
  const mode = COLLISIONS[request.collision ?? job.collision];
  const create = (as: StoreCollision, dedupeWindowMs = request.dedupeWindowMs ?? job.dedupeWindowMs) =>
    deps.store.createRun({
      ...request,
      input: inputForStore(job, parsed.data),
      jobVersion: job.version,
      // The request's cache mode, else the job's for this input, else read-write.
      cache: request.cache ?? job.cacheFor?.(parsed.data) ?? 'read-write',
      // The job's, after the request's fields: a caller never names it.
      subject: subjectOf(job, parsed.data),
      collision: as,
      dedupeWindowMs,
    });
  let { run, created } = await create(mode.storeAs);
  // Replace: cancel the open run on the key (its children with it), then start afresh, with no dedupe window (the run
  // just canceled ended inside it). A start racing this one may take the key first; then that run is the one replaced,
  // a bounded number of times.
  for (let tries = 0; mode.replaces && !created && ACTIVE_RUN.includes(run.status); tries++) {
    if (tries === 3)
      throw new RunPlanningError(`${job.key}: could not replace the open run on dedupe key ${request.dedupeKey}`);
    const { changed, run: canceled } = await deps.store.transition(run.id, { to: 'canceled' });
    if (changed && deps.events && deps.clock)
      await deps.events.emit({ ...eventBase(canceled, deps.clock), type: 'run.canceled' });
    ({ run, created } = await create(mode.storeAs, 0));
  }
  if (run.jobVersion !== job.version)
    throw new RunVersionConflictError(run.id, run.jobVersion, job.version);
  if (created) await recordInput(job, run, parsed.data);
  return { run, created };
}

interface ControlDeps {
  store: JobStore;
  clock: Clock;
  events?: EventSink;
}

/** An operator's pause. The run's in-flight chunks give their items back; resuming continues it. */
export async function pauseRun(deps: ControlDeps, runId: string) {
  const { changed, run } = await deps.store.transition(runId, {
    to: 'paused',
    reason: 'operator',
  });
  if (changed)
    await deps.events?.emit({
      ...eventBase(run, deps.clock),
      type: 'run.paused',
      reason: 'operator',
    });
  return run;
}

/** Continues a paused run, optionally under a new budget (a spent one re-pauses it at the next reservation). */
export async function resumeRun(
  deps: ControlDeps,
  runId: string,
  options: { budget?: Budget } = {},
) {
  const current = await deps.store.getRun(runId);
  if (current.status !== 'paused') return current;
  const { changed, run } = await deps.store.transition(runId, {
    to: 'running',
    from: 'paused',
    budget: options.budget,
  });
  if (changed)
    await deps.events?.emit({
      ...eventBase(run, deps.clock),
      type: 'run.resumed',
    });
  return run;
}

/** Cancels an open run: its chunks are canceled, so a worker still on one loses its claim at the next write. */
export async function cancelRun(deps: ControlDeps, runId: string) {
  const { changed, run } = await deps.store.transition(runId, {
    to: 'canceled',
  });
  if (changed)
    await deps.events?.emit({
      ...eventBase(run, deps.clock),
      type: 'run.canceled',
    });
  return run;
}

/** The run's subject, as its job names it from the parsed input, checked: a bad one is the definition's error. */
function subjectOf(job: AnyJob, input: unknown): RunSubject | null {
  const subject = job.subject?.(input) ?? null;
  if (subject === null) return null;
  const ok = (v: unknown, max: number) =>
    typeof v === 'string' && v.length > 0 && v.length <= max;
  if (
    !(
      ok(subject.kind, RUN_SUBJECT_KIND_MAX) &&
      ok(subject.id, RUN_SUBJECT_ID_MAX)
    )
  )
    throw new JobDefinitionError(
      `${job.key}: its subject needs a kind (1–${RUN_SUBJECT_KIND_MAX}) and an id (1–${RUN_SUBJECT_ID_MAX})`,
    );
  return { kind: subject.kind, id: subject.id };
}
