import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  type JobDescriptionValue,
  RUN_WAIT_MAX_MS,
  type RunListQueryValue,
  type RunPageValue,
  type RunValue,
  type RunWaitQueryValue,
  type StartRunRequestValue,
} from '../shapes/index.ts';
import {
  JOB_HEALTH_WINDOW,
  type JobsOpsChildAction,
  type JobsOpsChildActionInput,
  type JobsOpsEvents,
  type JobsOpsEventsInput,
  type JobsOpsJobs,
  type JobsOpsRefOptions,
  type JobsOpsRefOptionsInput,
  type JobsOpsRun,
  type JobsOpsRunAction,
  type JobsOpsRunEventsInput,
  type JobsOpsRunItem,
  type JobsOpsRunItems,
  type JobsOpsRunItemsInput,
  type JobsOpsRuns,
  type JobsOpsRunsInput,
  type JobsOpsSignal,
  type JobsOpsSignalInput,
  type JobsOpsStart,
  type JobsOpsStartInput,
  type JobsOpsStepOutput,
} from '../shapes/ops.ts';
import type { StepEntry } from '../define/define-job.ts';
import type { ErasedMapStep, ErasedPlainStep } from '../define/step.ts';
import { stepOutputOf } from '../engine/context.ts';
import { resultsOf } from '../engine/values.ts';
import {
  type AnyJob,
  authorityAtLeast,
  cancelRun,
  InputRefusedError,
  type ItemView,
  type ItemViewInput,
  itemViewSchema,
  JobDefinitionError,
  openGate,
  pauseRun,
  type Registry,
  type Run,
  RunNotFoundError,
  RunPlanningError,
  type RunRequest,
  resumeRun,
  retryChild,
  SignalRefusedError,
  type StepState,
  type StepView,
  signalRun,
  skipChild,
  startRun,
  stepViewSchema,
  TERMINAL_RUN,
} from '../index.ts';
import type { Clock, EventSink, Executor, JobStore, RunScope } from '../ports.ts';
import type {
  JobOperatorReads,
  JobRecentRun,
  OperatorItem,
  StoredJobEvent,
} from '../postgres.ts';
import { type AskedBudget, budgetFor } from './budget.ts';
import type {
  JobOperatorActor,
  JobSystemActor,
  TenantJobActor,
} from './job-actor.ts';
import { requesterOf } from './job-actor.ts';
import {
  type JobInputRefs,
  refValuesOf,
  viewRecordsOf,
} from './job-input-refs.ts';
import {
  JobInputInvalidError,
  JobNotFoundError,
  JobRefNotFoundError,
  JobRunEndedError,
  JobRunNotFoundError,
  JobSignalValueError,
  startRefusalOf,
  TooManyRunWaitsError,
} from './jobs.errors.ts';
import {
  assertLevel,
  levelOf,
  requireOperator,
  requireTenantActor,
  requireSystem,
  systemRun,
  visibleRun,
} from './jobs.policy.ts';
import {
  itemKeySchema,
  opsCursorOf,
  positionOfOpsCursor,
  timeKeyOf,
  timeKeySchema,
} from './ops-cursor.ts';
import { actionOf, jobOf, opsEventOf, opsRunSummaryOf } from './ops-view.ts';
import type { PublicJob, PublicJobCatalog } from './public-job-catalog.ts';
import { beforeOfCursor, runCursorOf } from './run-cursor.ts';
import { type StoredOutput, storedOutput } from './run-output.ts';
import {
  runSummaryOf,
  runViewOf,
  stepsOf,
  summedCounts,
  wireErrorOf,
} from './run-view.ts';
import {
  JOBS_CLOCK,
  JOBS_EVENTS,
  JOBS_EXECUTOR,
  JOBS_INPUT_REFS,
  JOBS_OPERATOR_READS,
  JOBS_TENANTS,
  JOBS_PUBLIC_CATALOG,
  JOBS_RUN_SCOPE,
  JOBS_WORKER,
  JOBS_REGISTRY,
  JOBS_STORE,
  type JobsTenants,
} from './tokens.ts';

/** How often a wait reads the run again. */
export const RUN_WAIT_POLL_MS = 2_000;
/** Waits one tenant may hold open in this process at once. */
export const MAX_RUN_WAITS_PER_TENANT = 8;

/** What a system start names: the run request, less what the actor decides (its tenant and requester). */
export type SystemRunRequest = Omit<
  RunRequest<unknown>,
  'tenantId' | 'requestedBy' | 'budget'
> & {
  /** Omitted: the job's limits (a job with no limits needs `maxItems`). */
  budget?: AskedBudget;
};

/** A recent run with its stored output, for a surface that projects it itself (Maintenance). */
export interface JobRunWithOutput {
  run: Run;
  output: StoredOutput | null;
}

/**
 * The job engine's one capability surface ("one owner, many surfaces", d86). Every method takes the `JobActor` its
 * surface built, and the part of the union its view serves (`jobs.policy.ts` holds every rule):
 *
 * - **The public view** (tenant actors: REST, an in-app page later) answers `@pattern-stack/jobs/shapes` shapes over public jobs
 *   only, in the actor's tenant.
 * - **The operator view** (the superuser: `jobsOps`, Maintenance's run list) answers `@pattern-stack/jobs/shapes` shapes
 *   across tenants, internal jobs included; a run's tenant is always its row's, never the input's.
 * - **The system view** (the app for one tenant: Maintenance's start, a gate's push) reaches its tenant's
 *   registered jobs with no job authority, audience or limit ceiling; the job's `admit` still runs, and engine errors
 *   are thrown as they are.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private readonly waits = new Map<string, number>();

  constructor(
    @Inject(JOBS_REGISTRY) private readonly registry: Registry,
    @Inject(JOBS_STORE) private readonly store: JobStore,
    @Inject(JOBS_OPERATOR_READS) private readonly reads: JobOperatorReads,
    @Inject(JOBS_EXECUTOR) private readonly executor: Executor,
    @Inject(JOBS_CLOCK) private readonly clock: Clock,
    @Inject(JOBS_EVENTS) private readonly events: EventSink,
    @Inject(JOBS_PUBLIC_CATALOG) private readonly catalog: PublicJobCatalog,
    @Inject(JOBS_TENANTS)
    private readonly tenants: JobsTenants,
    @Inject(JOBS_INPUT_REFS) private readonly refs: JobInputRefs,
    @Optional()
    @Inject(JOBS_RUN_SCOPE)
    private readonly around?: RunScope,
    // `false` in a process that starts runs but runs no executor loop (in-process `worker: false`): a submit there
    // would advance job code with no heartbeat renewing its lease. The worker's open-run sweep takes the run instead.
    @Optional()
    @Inject(JOBS_WORKER)
    private readonly worker?: boolean,
  ) {}

  // ── The public view (tenant actors) ─────────────────────────────────────────────────────────────────────────────────

  /** Every public job whose runs the actor may read (its `read` level). */
  listJobs(actor: TenantJobActor): JobDescriptionValue[] {
    requireTenantActor(actor);
    return [...this.catalog.values()]
      .filter((p) => authorityAtLeast(levelOf(actor), p.job.authority.read))
      .map((p) => p.description);
  }

  /** A public job, for an actor with its `read` level: below it, 403 (the public catalog names the job anyway). */
  loadJob(actor: TenantJobActor, jobKey: string): JobDescriptionValue {
    requireTenantActor(actor);
    const publicJob = this.publicJob(jobKey);
    assertLevel(actor, publicJob.job.authority.read);
    return publicJob.description;
  }

  /** Starts a run of a public job: a dry run unless asked, within the job's limits, by an actor with its level. */
  async start(
    actor: TenantJobActor,
    jobKey: string,
    body: StartRunRequestValue,
  ): Promise<{ run: RunValue; created: boolean }> {
    requireTenantActor(actor);
    const publicJob = this.publicJob(jobKey);
    const { job } = publicJob;
    assertLevel(
      actor,
      body.dryRun ? job.authority.dryRun : job.authority.start,
    );
    const parsed = publicJob.input.public.safeParse(body.input);
    if (!parsed.success)
      throw new JobInputInvalidError(
        parsed.error.issues.map((i) => ({
          path: i.path.map(String).join('.'),
          code: i.code,
        })),
      );
    const input = publicJob.input.fromPublic(parsed.data);
    const budget = budgetFor(job, body.budget, {
      now: this.clock.now(),
      ceiling: true,
    });
    await this.assertRefsResolve(job, input, actor.tenantId);
    let started: { run: Run; created: boolean };
    try {
      started = await startRun(
        { registry: this.registry, store: this.store, around: this.around },
        {
          jobKey,
          input,
          tenantId: actor.tenantId,
          trigger: body.trigger,
          requestedBy: requesterOf(actor),
          budget,
          dedupeKey: body.dedupeKey,
          dryRun: body.dryRun,
        },
      );
    } catch (err) {
      throw startRefusalOf(err, 'public');
    }
    await this.submit(started.run.id);
    return {
      run: await this.viewOf(publicJob, started.run),
      created: started.created,
    };
  }

  /** One public job's runs in the actor's tenant, newest first, a keyset page at a time. */
  async listRuns(
    actor: TenantJobActor,
    jobKey: string,
    query: RunListQueryValue,
  ): Promise<RunPageValue> {
    requireTenantActor(actor);
    const { job } = this.publicJob(jobKey);
    assertLevel(actor, job.authority.read);
    const filters = { jobKey, status: query.status };
    const runs = await this.store.listRuns({
      tenantId: actor.tenantId,
      jobKey,
      status: query.status,
      limit: query.limit + 1,
      before: beforeOfCursor(query.cursor, filters),
    });
    const page = runs.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      runs: page.map(runSummaryOf),
      nextCursor:
        runs.length > query.limit && last ? runCursorOf(last, filters) : null,
    };
  }

  async loadRun(actor: TenantJobActor, runId: string): Promise<RunValue> {
    requireTenantActor(actor);
    const run = await this.runOf(runId);
    return this.viewOf(visibleRun(actor, run, this.catalog), run);
  }

  /**
   * The run once its revision moves past `after` (default: the run as this call first reads it) or it ends, else at
   * the deadline (at most `RUN_WAIT_MAX_MS`), polled every `RUN_WAIT_POLL_MS`. An aborted signal answers at once.
   */
  async loadRunChange(
    actor: TenantJobActor,
    runId: string,
    query: RunWaitQueryValue,
    signal?: AbortSignal,
  ): Promise<RunValue> {
    requireTenantActor(actor);
    const tenant = actor.tenantId;
    const held = this.waits.get(tenant) ?? 0;
    if (held >= MAX_RUN_WAITS_PER_TENANT)
      throw new TooManyRunWaitsError();
    this.waits.set(tenant, held + 1);
    try {
      const run = await this.runOf(runId);
      const publicJob = visibleRun(actor, run, this.catalog);
      const now = () => this.clock.now().getTime();
      const deadline = now() + Math.min(query.timeoutMs, RUN_WAIT_MAX_MS);
      let progress = await this.store.progress(run.id);
      let view = runViewOf(publicJob, progress, null);
      const base = query.after ?? view.revision;
      while (
        !TERMINAL_RUN.includes(view.status) &&
        view.revision === base &&
        now() < deadline
      ) {
        try {
          await this.clock.sleep(
            Math.min(RUN_WAIT_POLL_MS, deadline - now()),
            signal,
          );
        } catch (error) {
          // The one expected rejection: the caller went away and aborted the sleep.
          if (signal?.aborted) break;
          throw error;
        }
        progress = await this.store.progress(run.id);
        view = runViewOf(publicJob, progress, null);
      }
      return view.status === 'completed'
        ? {
            ...view,
            output: await this.publicOutputOf(publicJob, progress.run),
          }
        : view;
    } finally {
      const left = (this.waits.get(tenant) ?? 1) - 1;
      if (left > 0) this.waits.set(tenant, left);
      else this.waits.delete(tenant);
    }
  }

  /**
   * Cancels an open run, by whoever may start that kind of run. A repeated cancel answers the canceled run. The store's
   * transition is the compare-and-set: a run that completed or failed after this call read it answers `run_ended`
   * with the status it reached, never a 200 for a cancel that did not happen.
   */
  async cancel(actor: TenantJobActor, runId: string): Promise<RunValue> {
    requireTenantActor(actor);
    const run = await this.runOf(runId);
    const publicJob = visibleRun(actor, run, this.catalog);
    const { authority } = publicJob.job;
    assertLevel(actor, run.dryRun ? authority.dryRun : authority.start);
    const after = await this.cancelOf(run);
    if (after.status !== 'canceled') throw new JobRunEndedError(after.status);
    return this.viewOf(publicJob, after);
  }

  // ── The operator view (the superuser) ────────────────────────────────────────────────────────────────────────────

  /** Every registered job, with its health over its newest runs, read in one query. */
  async listJobsWithHealth(operator: JobOperatorActor): Promise<JobsOpsJobs> {
    requireOperator(operator);
    const jobs = this.registry.list();
    const recent = await this.reads.listNewestRunsPerJob(
      jobs.map((j) => j.key),
      JOB_HEALTH_WINDOW,
    );
    const runsOf = new Map<string, JobRecentRun[]>();
    for (const run of recent)
      runsOf.set(run.jobKey, [...(runsOf.get(run.jobKey) ?? []), run]);
    return {
      jobs: jobs
        .map((job) => jobOf(this.registry, job, runsOf.get(job.key) ?? []))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
  }

  /** Runs across tenants, newest first, keyset paged. */
  async listRunsAcrossTenants(
    operator: JobOperatorActor,
    input: JobsOpsRunsInput,
  ): Promise<JobsOpsRuns> {
    requireOperator(operator);
    const filters = {
      jobKey: input.jobKey,
      tenantId: input.tenantId,
      status: input.status,
      subjectKind: input.subject?.kind,
      subjectId: input.subject?.id,
      parentRunId: input.parentRunId,
    };
    const before = positionOfOpsCursor(input.cursor, timeKeySchema, filters);
    const runs = await this.reads.listRunsAcrossTenants({
      jobKey: input.jobKey,
      tenantId: input.tenantId,
      status: input.status,
      subject: input.subject,
      parentRunId: input.parentRunId,
      before,
      limit: input.limit + 1,
    });
    const page = runs.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      runs: page.map(opsRunSummaryOf),
      nextCursor:
        runs.length > input.limit && last
          ? opsCursorOf(timeKeyOf(last.createdAt, last.id), filters)
          : null,
    };
  }

  /**
   * The newest runs of these jobs across tenants, each with its stored output once completed: for a superuser
   * surface that projects them itself (Maintenance's run list).
   */
  async listRecentRuns(
    operator: JobOperatorActor,
    filter: { jobKeys: readonly string[]; limit: number },
  ): Promise<JobRunWithOutput[]> {
    requireOperator(operator);
    if (!filter.jobKeys.length) return [];
    const runs = await this.reads.listRecentAcrossTenants(filter);
    return Promise.all(
      runs.map(async (run) => ({
        run,
        output:
          run.status === 'completed' ? await this.storedOutputOf(run) : null,
      })),
    );
  }

  /**
   * One run: its record, its steps, and its output once completed. A completed plain step carries its `summary`: its
   * step's `present` run now over its stored output (null with no presenter, a throw, a null answer or one
   * `stepViewSchema` refuses), so the page reads each step's one line and never its whole output.
   */
  async loadRunRecord(
    operator: JobOperatorActor,
    runId: string,
  ): Promise<JobsOpsRun> {
    requireOperator(operator);
    const run = await this.runOf(runId);
    const progress = await this.store.progress(run.id);
    const job = this.registry.has(run.jobKey)
      ? this.registry.get(run.jobKey)
      : undefined;
    const summaries = await this.stepSummariesOf(
      progress.run,
      job,
      progress.steps,
    );
    const steps = stepsOf(job, progress).map((step) => ({
      ...step,
      summary: summaries.get(step.name) ?? null,
    }));
    let output: unknown = null;
    let outputUnreadable = false;
    if (progress.run.status === 'completed') {
      const stored = await this.storedOutputOf(progress.run);
      if (stored.readable)
        // A plain-JSON copy: an output schema may parse to values tRPC would carry differently.
        output = JSON.parse(JSON.stringify(stored.output ?? null));
      else outputUnreadable = true;
    }
    return {
      run: {
        ...opsRunSummaryOf(progress.run),
        counts: summedCounts(steps),
        steps,
      },
      output,
      outputUnreadable,
      treeSpend: await this.store.treeSpend(run.id),
    };
  }

  /**
   * A step's items, failed first, then the rest, each in planned order; keyset paged. Each item carries its stored
   * result (the full stored JSON, null when none) and how it reads (`view`): the step's `present` run now, over the
   * result as its result schema parses it. No presenter, a throw or an answer `itemViewSchema` refuses gives `view:
   * null` (the page shows the key), with one warning per step per read.
   */
  async listRunItems(
    operator: JobOperatorActor,
    input: JobsOpsRunItemsInput,
  ): Promise<JobsOpsRunItems> {
    requireOperator(operator);
    const run = await this.runOf(input.runId);
    const filters = {
      runId: input.runId,
      step: input.step,
      status: input.status,
    };
    const after = positionOfOpsCursor(input.cursor, itemKeySchema, filters);
    const items = await this.reads.listRunItems({
      runId: input.runId,
      step: input.step,
      status: input.status,
      after,
      limit: input.limit + 1,
    });
    const page = items.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: await this.itemsWithViews(run, input.step, page),
      nextCursor:
        items.length > input.limit && last
          ? opsCursorOf(
              {
                rank: last.status === 'failed' ? 0 : 1,
                ordinal: last.ordinal,
              },
              filters,
            )
          : null,
    };
  }

  /**
   * A plain step's stored output and how it reads, for its expanded row: the step's `present` run now over the output
   * (null until the step completed), with its status and error. No presenter, a throw, a null answer or one
   * `stepViewSchema` refuses gives `view: null`, warned once; the output is still answered. 404 `job_not_found` for a
   * job this process doesn't register, 404 `step_not_found` for a step it doesn't define, 400 `not_a_plain_step` for
   * any other kind (a map step's items are `listRunItems`).
   */
  async loadStepOutput(
    operator: JobOperatorActor,
    runId: string,
    stepName: string,
  ): Promise<JobsOpsStepOutput> {
    requireOperator(operator);
    const run = await this.runOf(runId);
    const job = this.registeredJob(run.jobKey);
    const entry = job.steps.find((s) => s.name === stepName);
    if (!entry)
      throw new NotFoundException({
        message: 'The job has no step with this name',
        code: 'step_not_found',
      });
    if (entry.erased.kind !== 'step')
      throw new BadRequestException({
        message: 'Only a plain step has an output to show',
        code: 'not_a_plain_step',
      });
    const state =
      (await this.store.stepStates(run.id)).find((s) => s.name === stepName) ??
      null;
    const error = stepErrorOf(state);
    const output =
      state?.status === 'completed'
        ? await this.plainStepOutputOf(run, entry, state)
        : null;
    const view = presentStep(
      entry.erased,
      { output, status: state?.status ?? 'pending', error },
      this.stepWarner(run.id, stepName),
    );
    const [records = []] = await viewRecordsOf(this.refs, run.tenantId, [
      view,
    ]);
    return { view, output, error, records };
  }

  /** A run's events, oldest first; keyset paged. */
  async listRunEvents(
    operator: JobOperatorActor,
    input: JobsOpsRunEventsInput,
  ): Promise<JobsOpsEvents> {
    requireOperator(operator);
    await this.runOf(input.runId);
    const filters = { runId: input.runId };
    const after = positionOfOpsCursor(input.cursor, timeKeySchema, filters);
    const events = await this.reads.listRunEvents({
      runId: input.runId,
      after,
      limit: input.limit + 1,
    });
    return this.eventPage(events, input.limit, filters);
  }

  /** The event log across tenants, newest first; keyset paged. */
  async listEvents(
    operator: JobOperatorActor,
    input: JobsOpsEventsInput,
  ): Promise<JobsOpsEvents> {
    requireOperator(operator);
    const filters = {
      jobKey: input.jobKey,
      tenantId: input.tenantId,
      type: input.type,
    };
    const before = positionOfOpsCursor(input.cursor, timeKeySchema, filters);
    const events = await this.reads.listEvents({
      ...filters,
      before,
      limit: input.limit + 1,
    });
    return this.eventPage(events, input.limit, filters);
  }

  /**
   * Start run's lookup of one kind of domain id a job's input names: the tenant's live ones whose name holds the
   * words, by name, at most `limit` (50), through the source the kind's context registered. Scoped to the tenant
   * the form names, which must exist.
   */
  async listRefOptions(
    operator: JobOperatorActor,
    input: JobsOpsRefOptionsInput,
  ): Promise<JobsOpsRefOptions> {
    requireOperator(operator);
    await this.requireTenant(input.tenantId);
    const source = this.refs.sourceOf(input.ref);
    // The boot check makes this unreachable for any kind a registered job names.
    if (!source)
      throw new NotFoundException({
        message: 'No lookup is registered for this kind',
        code: 'ref_kind_not_found',
      });
    // A kind only views name (`observation`) has nothing to pick from.
    if (!source.listOptions)
      throw new BadRequestException({
        message: 'This kind has no options to pick from',
        code: 'ref_kind_not_listable',
      });
    return {
      options: await source.listOptions(
        input.tenantId,
        input.q,
        input.limit,
      ),
    };
  }

  /**
   * Starts a run of any registered job for a tenant: the superuser gate is the authority, so no audience,
   * authority or limit ceiling applies; the job's `admit` still runs, and the ids its input names must resolve in the
   * tenant. An omitted budget field is the job's limit; a job with no limits needs `maxItems`.
   */
  async startForTenant(
    operator: JobOperatorActor,
    input: JobsOpsStartInput,
  ): Promise<JobsOpsStart> {
    requireOperator(operator);
    const job = this.registeredJob(input.jobKey);
    await this.requireTenant(input.tenantId);
    const budget = budgetFor(job, input.budget, {
      now: this.clock.now(),
      ceiling: false,
    });
    // Ids are read from the input as the job parses it; an input it refuses is the engine's to answer.
    const parsed = job.input.safeParse(input.input);
    if (parsed.success)
      await this.assertRefsResolve(job, parsed.data, input.tenantId);
    let started: { run: Run; created: boolean };
    try {
      started = await startRun(
        { registry: this.registry, store: this.store, around: this.around },
        {
          jobKey: job.key,
          input: input.input,
          tenantId: input.tenantId,
          trigger: 'manual',
          requestedBy: requesterOf(operator),
          budget,
          dedupeKey: input.dedupeKey,
          dryRun: input.dryRun,
          cache: input.cache,
        },
      );
    } catch (err) {
      throw startRefusalOf(err, 'operator');
    }
    await this.submit(started.run.id);
    return { run: opsRunSummaryOf(started.run), created: started.created };
  }

  /**
   * Approve: delivers a signal to a run's waiting step as the superuser (`settled_by_user_id`). The superuser holds
   * every level, so the wait's authority always passes here. The engine parses the value, runs the step's `accept`,
   * settles the step (the first signal wins) and submits the run. Each refusal is the superuser's own input, echoed:
   * a step not waiting for the signal is 409 `wait_not_open`; a value its schema refuses is 400
   * `signal_value_invalid` with each issue's path and code, never the value; an `accept` refusal is 400 with its code.
   */
  async signal(
    operator: JobOperatorActor,
    input: JobsOpsSignalInput,
  ): Promise<JobsOpsSignal> {
    requireOperator(operator);
    const before = await this.runOf(input.runId);
    try {
      const { run } = await signalRun(this.submittingDeps(), {
        ...input,
        runId: before.id,
        by: operator.userId,
      });
      return { run: opsRunSummaryOf(run) };
    } catch (err) {
      if (err instanceof SignalRefusedError)
        throw err.code === 'wait_not_open'
          ? new ConflictException({ message: err.message, code: err.code })
          : new JobSignalValueError(err.message, err.issues);
      if (err instanceof InputRefusedError)
        throw new BadRequestException({ message: err.message, code: err.code });
      throw err;
    }
  }

  /**
   * Retry: a new child run in a failed slot (its key and input, the failed attempt's budget), submitted; the parent's
   * waiting step reads it when it ends. `changed: false` when the slot isn't failed (settled, retried or skipped
   * first). A step that is no children step of the run's job is a 400.
   */
  async retryChild(
    operator: JobOperatorActor,
    input: JobsOpsChildActionInput,
  ): Promise<JobsOpsChildAction> {
    requireOperator(operator);
    const parent = await this.runOf(input.runId);
    try {
      const slot = await retryChild(this.submittingDeps(), {
        ...input,
        runId: parent.id,
      });
      return { changed: slot !== null, childRunId: slot?.childRunId ?? null };
    } catch (err) {
      throw childRefusalOf(err);
    }
  }

  /** Skip: a failed slot settles as skipped and the parent's waiting step reads its slots again. */
  async skipChild(
    operator: JobOperatorActor,
    input: JobsOpsChildActionInput,
  ): Promise<JobsOpsChildAction> {
    requireOperator(operator);
    const parent = await this.runOf(input.runId);
    try {
      const slot = await skipChild(this.submittingDeps(), {
        ...input,
        runId: parent.id,
      });
      return { changed: slot !== null, childRunId: slot?.childRunId ?? null };
    } catch (err) {
      throw childRefusalOf(err);
    }
  }

  /**
   * Cancel, pause or resume any run, through the engine's own transitions; a resume is submitted at once, so it
   * advances without waiting for the sweep. `changed` only when the run moved into the action's status.
   */
  async controlRun(
    operator: JobOperatorActor,
    runId: string,
    action: 'cancel' | 'pause' | 'resume',
  ): Promise<JobsOpsRunAction> {
    requireOperator(operator);
    const before = await this.runOf(runId);
    if (action === 'cancel')
      return actionOf(before, await this.cancelOf(before), 'canceled');
    if (action === 'pause')
      return actionOf(
        before,
        await pauseRun(this.controlDeps(), before.id),
        'paused',
      );
    const after = await resumeRun(this.controlDeps(), before.id);
    const answer = actionOf(before, after, 'running');
    if (answer.changed) await this.submit(after.id);
    return answer;
  }

  // ── The system view (the app, for one tenant) ──────────────────────────────────────────────────────────────

  /**
   * Creates a run (or finds the open one on its dedupe key) of any registered job in the actor's tenant, and
   * submits it: no audience, authority or limit ceiling, since the caller applied its own authority. An omitted budget
   * is the job's limits. The job's `admit` still runs, and the engine's refusals are thrown as they are.
   */
  async startSystemRun(
    actor: JobSystemActor,
    request: SystemRunRequest,
  ): Promise<{ run: Run; created: boolean }> {
    requireSystem(actor);
    const job = this.registeredJob(request.jobKey);
    const started = await startRun(
      { registry: this.registry, store: this.store, around: this.around },
      {
        ...request,
        tenantId: actor.tenantId,
        requestedBy: requesterOf(actor),
        budget: budgetFor(job, request.budget, {
          now: this.clock.now(),
          ceiling: false,
        }),
      },
    );
    // A dedupe incumbent is submitted again too: deduplicated, so harmless.
    await this.submit(started.run.id);
    return started;
  }

  /**
   * A gate's push: the code that opens an outside condition (the tenant's AI switch turned back on, a version's
   * backfill finished) wakes the actor's tenant's runs waiting on it now, instead of at their next poll. It only
   * makes due what the gate's own read then decides. Returns the runs it woke.
   */
  async openGate(actor: JobSystemActor, name: string): Promise<string[]> {
    requireSystem(actor);
    return openGate(
      { store: this.store, executor: { submit: (runId: string) => this.submit(runId) } },
      actor.tenantId,
      name,
    );
  }

  /** A run of the actor's tenant: any registered job's. Another tenant's is a 404. */
  async loadSystemRun(actor: JobSystemActor, runId: string): Promise<Run> {
    requireSystem(actor);
    return systemRun(actor, await this.runOf(runId));
  }

  // ── Shared ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A page of items with their stored results and views (`listRunItems`). */
  private async itemsWithViews(
    run: Run,
    stepName: string,
    page: readonly OperatorItem[],
  ): Promise<JobsOpsRunItem[]> {
    const step = this.registry.has(run.jobKey)
      ? this.registry.get(run.jobKey).steps.find((s) => s.name === stepName)
          ?.erased
      : undefined;
    const map = step?.kind === 'map' ? step : undefined;
    const stored = map
      ? await resultsOf(
          this.store,
          run,
          stepName,
          map,
          page.map((i) => i.key),
        )
      : new Map<string, unknown>();
    let warned = false;
    const warnOnce = (why: string) => {
      if (warned) return;
      warned = true;
      this.logger.warn(
        `job run ${run.id}, step ${stepName}: an item view fell back to the key (${why})`,
      );
    };
    const items = page.map((item) => {
      const raw = stored.get(item.key);
      const result = raw === undefined ? null : raw;
      const error = item.errorType ? itemErrorOf(item.errorType) : null;
      return {
        ordinal: item.ordinal,
        chunkIndex: item.chunkIndex,
        key: item.key,
        ref: item.ref,
        status: item.status,
        attempts: item.attempts,
        error,
        // The full stored JSON, as a plain copy.
        result: result === null ? null : JSON.parse(JSON.stringify(result)),
        view: map?.present
          ? viewOf(map, { ...item, result, error }, warnOnce)
          : null,
      };
    });
    const records = await viewRecordsOf(
      this.refs,
      run.tenantId,
      items.map((item) => item.view),
    );
    return items.map((item, at) => ({ ...item, records: records[at] ?? [] }));
  }

  /** Each completed plain step's summary, by name (`loadRunRecord`): only steps whose definition has a presenter. */
  private async stepSummariesOf(
    run: Run,
    job: AnyJob | undefined,
    states: readonly StepState[],
  ): Promise<Map<string, string | null>> {
    const summaries = new Map<string, string | null>();
    if (!job) return summaries;
    for (const state of states) {
      const entry = job.steps.find((s) => s.name === state.name);
      if (
        state.status !== 'completed' ||
        entry?.erased.kind !== 'step' ||
        !entry.erased.present
      )
        continue;
      const output = await this.plainStepOutputOf(run, entry, state);
      const view = presentStep(
        entry.erased,
        { output, status: state.status, error: stepErrorOf(state) },
        this.stepWarner(run.id, state.name),
      );
      summaries.set(state.name, view?.summary ?? null);
    }
    return summaries;
  }

  /**
   * A completed plain step's stored output as a plain JSON copy (null for a void one), read where it lives (the store
   * or its recorder). A recorder that holds none is null, logged: the page shows the step without its output.
   */
  private async plainStepOutputOf(
    run: Run,
    entry: StepEntry,
    state: StepState,
  ): Promise<unknown> {
    try {
      const output = await stepOutputOf(this.store, run, entry, state);
      return JSON.parse(JSON.stringify(output ?? null));
    } catch (err) {
      if (!(err instanceof RunPlanningError)) throw err;
      this.logger.warn(
        `job run ${run.id}, step ${entry.name}: its output could not be read (${err.name})`,
      );
      return null;
    }
  }

  /** A step view's warning, said once per step per read. */
  private stepWarner(runId: string, stepName: string): (why: string) => void {
    let warned = false;
    return (why) => {
      if (warned) return;
      warned = true;
      this.logger.warn(
        `job run ${runId}, step ${stepName}: its step view fell back to none (${why})`,
      );
    };
  }

  /** A public job by key: an internal or unknown key is the same 404. */
  private publicJob(jobKey: string): PublicJob {
    const publicJob = this.catalog.get(jobKey);
    if (!publicJob) throw new JobNotFoundError();
    return publicJob;
  }

  /** Any registered job by key, for the operator and the system: unknown is 404. */
  private registeredJob(jobKey: string): AnyJob {
    if (!this.registry.has(jobKey))
      throw new NotFoundException({
        message: 'No job is registered with this key',
        code: 'job_not_found',
      });
    return this.registry.get(jobKey);
  }

  /** The run, or 404 `run_not_found`: the one run read every view starts from. */
  private async runOf(runId: string): Promise<Run> {
    try {
      return await this.store.getRun(runId);
    } catch (err) {
      if (err instanceof RunNotFoundError) throw new JobRunNotFoundError();
      throw err;
    }
  }

  private async requireTenant(tenantId: string): Promise<void> {
    if (!(await this.tenants.findById(tenantId)))
      throw new NotFoundException({
        message: 'No tenant has this id',
        code: 'tenant_not_found',
      });
  }

  /**
   * Every id the input names in a `jobRef` field must resolve in the run's tenant, before the run exists: a
   * cross-tenant id is refused at the boundary (400 `ref_not_found`, the field's path, never the id).
   */
  private async assertRefsResolve(
    job: AnyJob,
    input: unknown,
    tenantId: string,
  ): Promise<void> {
    for (const { field, ids } of refValuesOf(job.input, input)) {
      if (!ids.length) continue;
      const source = this.refs.sourceOf(field.kind);
      if (!source) throw new JobRefNotFoundError(field.path, field.kind);
      const found = new Set(
        (await source.resolve(tenantId, ids)).map((o) => o.id),
      );
      if (ids.some((id) => !found.has(id)))
        throw new JobRefNotFoundError(field.path, source.label);
    }
  }

  /** Submits a run; a failed submit is logged, never thrown: the every-minute sweep resubmits open runs. */
  private async submit(runId: string): Promise<void> {
    if (this.worker === false) return;
    try {
      await this.executor.submit(runId);
    } catch (err) {
      this.logger.warn(
        `job run ${runId} was not submitted (${err instanceof Error ? err.name : typeof err}); the sweep resubmits it`,
      );
    }
  }

  /** The one cancel: the store's transition is the compare-and-set; a canceled run is answered as it is. */
  private async cancelOf(run: Run): Promise<Run> {
    return run.status === 'canceled'
      ? run
      : cancelRun(this.controlDeps(), run.id);
  }

  private controlDeps() {
    return { store: this.store, clock: this.clock, events: this.events };
  }

  private submittingDeps() {
    return {
      ...this.controlDeps(),
      registry: this.registry,
      executor: { submit: (runId: string) => this.submit(runId) },
      around: this.around,
    };
  }

  private storedOutputOf(run: Run): Promise<StoredOutput> {
    return storedOutput(
      {
        store: this.store,
        registry: this.registry,
        warn: (message) => this.logger.warn(message),
      },
      run,
    );
  }

  private async viewOf(publicJob: PublicJob, run: Run): Promise<RunValue> {
    const progress = await this.store.progress(run.id);
    const output =
      progress.run.status === 'completed'
        ? await this.publicOutputOf(publicJob, progress.run)
        : null;
    return runViewOf(publicJob, progress, output);
  }

  /** A completed run's public output, or null when its stored output no longer reads under the current definition. */
  private async publicOutputOf(
    publicJob: PublicJob,
    run: Run,
  ): Promise<Record<string, unknown> | null> {
    const stored = await this.storedOutputOf(run);
    if (!stored.readable) return null;
    const parsed = publicJob.output.safeParse(stored.output);
    if (!parsed.success) {
      this.logger.warn(
        `job run ${run.id}: its output no longer parses under the current definition`,
      );
      return null;
    }
    return publicJob.output.toPublic(parsed.data) as Record<string, unknown>;
  }

  private eventPage(
    events: StoredJobEvent[],
    limit: number,
    filters: Record<string, string | undefined>,
  ): JobsOpsEvents {
    const page = events.slice(0, limit);
    const last = page[page.length - 1];
    return {
      events: page.map(opsEventOf),
      nextCursor:
        events.length > limit && last
          ? opsCursorOf(timeKeyOf(last.at, last.id), filters)
          : null,
    };
  }
}

/** A step that is no children step, or a one-child step's skip: the superuser's own input, said. */
function childRefusalOf(err: unknown): unknown {
  return err instanceof JobDefinitionError
    ? new BadRequestException({
        message: err.message,
        code: 'not_a_child_slot',
      })
    : err;
}

/** An item's stored error as the wire carries it: its type and a fixed sentence (items keep no message). */
function itemErrorOf(type: string): { kind: string; message: string } {
  const wire = wireErrorOf({ type, message: '' }, 'step');
  return {
    kind: wire?.type ?? 'Error',
    message:
      wire?.message === 'The step failed.'
        ? 'The item failed.'
        : (wire?.message ?? 'The item failed.'),
  };
}

/** A step's error as the step view and its wire read it: its type and a fixed sentence. */
function stepErrorOf(
  state: StepState | null,
): { kind: string; message: string } | null {
  const wire = state ? wireErrorOf(state.error, 'step') : null;
  return wire ? { kind: wire.type, message: wire.message } : null;
}

/**
 * One plain step's view: its presenter over the step as stored, checked against `stepViewSchema`. No presenter or a
 * null answer is null; a throw or a refused answer is null too, and said once per step.
 */
function presentStep(
  step: ErasedPlainStep,
  input: {
    output: unknown;
    status: StepState['status'];
    error: { kind: string; message: string } | null;
  },
  warn: (why: string) => void,
): StepView | null {
  if (!step.present) return null;
  let answer: unknown;
  try {
    answer = step.present(input);
  } catch (err) {
    warn(`its presenter threw ${err instanceof Error ? err.name : typeof err}`);
    return null;
  }
  if (answer === null) return null;
  const view = stepViewSchema.safeParse(answer);
  if (!view.success) {
    warn('its presenter answered outside stepViewSchema');
    return null;
  }
  return view.data;
}

/**
 * One item's view: the step's presenter over the item, its result parsed by the step's result schema (null when it
 * doesn't parse), checked against `itemViewSchema`. A throw or a refused answer is null, and said once per step.
 */
function viewOf(
  step: ErasedMapStep,
  item: {
    ref: string;
    key: string;
    status: ItemViewInput<unknown>['status'];
    result: unknown;
    error: { kind: string; message: string } | null;
  },
  warn: (why: string) => void,
): ItemView | null {
  if (!step.present) return null;
  let result: unknown = item.result;
  if (result !== null && step.resultSchema) {
    const parsed = step.resultSchema.safeParse(result);
    result = parsed.success ? parsed.data : null;
  }
  let answer: unknown;
  try {
    answer = step.present({
      ref: item.ref,
      key: item.key,
      status: item.status,
      result,
      error: item.error,
    });
  } catch (err) {
    warn(`its presenter threw ${err instanceof Error ? err.name : typeof err}`);
    return null;
  }
  const view = itemViewSchema.safeParse(answer);
  if (!view.success) {
    warn('its presenter answered outside itemViewSchema');
    return null;
  }
  return view.data;
}
