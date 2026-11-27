/**
 * `@pattern-stack/jobs/shapes`: the superuser jobs surface's tRPC contract (`jobsOps`). Camelcase app shapes, never
 * published on the public API: every registered job (internal ones too), runs across tenants, a run's steps,
 * output, items and events, and the operator's actions. Events and errors carry ids, counts and types, never content.
 */
import { z } from 'zod';
import { JOB_HEALTH_WINDOW } from './health.ts';
import { JOB_REF_KIND_PATTERN, jobsOpsInputFormSchema } from './input-form.ts';
import { itemCountsSchema, runSummaryFields, stepStateSchema } from './run.ts';
import {
  CACHE_MODES,
  DEDUPE_KEY_PATTERN,
  JOB_AUTHORITY_LEVELS,
  LIMITER_SCOPES,
  PAUSE_REASONS,
  RUN_STATUSES,
  STEP_KINDS,
  WAIT_KINDS,
} from './vocabulary.ts';

const count = z.number().int().nonnegative();
const datetime = z.iso.datetime();
const cursor = z.string().min(1).max(512);

/** Who may see a job: an internal one is reached only in-process and by this surface. */
export const JOB_AUDIENCES = ['internal', 'public'] as const;

/** An item's states (`@pattern-stack/jobs` `ItemStatus`). */
export const ITEM_STATUSES = [
  'pending',
  'done',
  'cached',
  'failed',
  'skipped',
] as const;

/** The fixed list of events a run emits (`@pattern-stack/jobs` `JOB_EVENT_TYPES`). */
export const JOB_EVENT_TYPES = [
  'run.started',
  'run.paused',
  'run.resumed',
  'run.completed',
  'run.failed',
  'run.canceled',
  'step.started',
  'step.progress',
  'step.completed',
  'step.failed',
  'step.skipped',
  'step.retried',
  'step.waiting',
  'step.woke',
  'step.signaled',
  'child.started',
  'child.ended',
  'item.failed',
] as const;

export {
  JOB_HEALTH_WINDOW,
  type JobHealthOf,
  type JobHealthRun,
  jobHealthOf,
} from './health.ts';
export {
  FORM_STRING_FORMATS,
  type FormControl,
  type FormField,
  type FormStringFormat,
  formDefaultsOf,
  formFieldsOf,
  formValueProblemOf,
  JOB_REF_KIND_PATTERN,
  type JobRefKind,
  type JobsOpsInputForm,
  jobRef,
  jobsOpsInputFormSchema,
  labelOf,
} from './input-form.ts';
export const JOBS_OPS_PAGE_DEFAULT = 50;
export const JOBS_OPS_PAGE_MAX = 200;

const pageLimit = z
  .number()
  .int()
  .min(1)
  .max(JOBS_OPS_PAGE_MAX)
  .default(JOBS_OPS_PAGE_DEFAULT);

// ----- jobs -----

export const jobsOpsHealthSchema = z.object({
  window: count.describe(
    `The newest runs read, at most ${JOB_HEALTH_WINDOW}, any status`,
  ),
  open: count.describe('Of those, pending, running, waiting or paused'),
  completed: count,
  failed: count,
  canceled: count,
  successRate: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .describe('completed / (completed + failed); null with neither'),
  durationMs: z
    .object({ avg: count, p50: count, max: count })
    .nullable()
    .describe('Started to completed, over the completed runs; null with none'),
  lastRun: z
    .object({
      id: z.string().min(1),
      tenantId: z.string().min(1),
      status: z.enum(RUN_STATUSES),
      createdAt: datetime,
      completedAt: datetime.nullable(),
    })
    .nullable(),
});

/** A wait step's signal: what Approve sends, who may send it, and the form its value is asked with. */
export const jobsOpsSignalDescriptionSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  /** Its own level; null: the level that started the run. */
  authority: z.enum(JOB_AUTHORITY_LEVELS).nullable(),
  /** How Approve asks for the value: a form, or JSON (as Start run asks for an input). */
  value: jobsOpsInputFormSchema,
  timeout: z
    .object({ afterMs: count, fallback: z.enum(['fail', 'value']) })
    .nullable(),
});

export const jobsOpsJobSchema = z.object({
  key: z.string(),
  version: z.string(),
  audience: z.enum(JOB_AUDIENCES),
  steps: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(STEP_KINDS),
      batchMax: z.number().int().positive().nullable(),
      limiters: z.array(
        z.object({ name: z.string(), per: z.enum(LIMITER_SCOPES) }),
      ),
      signal: jobsOpsSignalDescriptionSchema
        .nullable()
        .describe('A wait step: the signal it waits for; null for any other'),
    }),
  ),
  authority: z.object({
    read: z.enum(JOB_AUTHORITY_LEVELS),
    dryRun: z.enum(JOB_AUTHORITY_LEVELS),
    start: z.enum(JOB_AUTHORITY_LEVELS),
  }),
  limits: z
    .object({
      maxItems: count,
      maxUsd: z.number().nonnegative(),
      maxCalls: count,
      maxDurationMs: count,
    })
    .nullable()
    .describe('An internal job may declare none'),
  input: jobsOpsInputFormSchema.describe(
    "How Start run asks for the job's input: nothing, a form, or JSON",
  ),
  health: jobsOpsHealthSchema,
});

export const jobsOpsJobsSchema = z.object({ jobs: z.array(jobsOpsJobSchema) });

// ----- runs -----

/**
 * What a run is about, as its job named it from its input (`Run.subject` in `@pattern-stack/jobs`): a free-text kind and the
 * subject's id. The bounds restate the engine's `RUN_SUBJECT_KIND_MAX` / `RUN_SUBJECT_ID_MAX`.
 */
export const jobsOpsRunSubjectSchema = z.object({
  kind: z.string().min(1).max(64),
  id: z.string().min(1).max(255),
});

/** A run as a list row: the record, with its tenant (the operator reads across tenants). */
export const jobsOpsRunSummarySchema = z.object({
  ...runSummaryFields,
  tenantId: z.string().min(1),
  cache: z
    .enum(CACHE_MODES)
    .describe(
      "The cache mode the run ran under: the request's, else the job's for its input, else read-write",
    ),
  subject: jobsOpsRunSubjectSchema
    .nullable()
    .describe(
      'What the run is about, named by its job; null when it names none',
    ),
});

export const jobsOpsRunsInputSchema = z.object({
  jobKey: z.string().min(1).max(128).optional(),
  tenantId: z.string().min(1).optional(),
  status: z.enum(RUN_STATUSES).optional(),
  subject: jobsOpsRunSubjectSchema
    .optional()
    .describe(
      "Only the runs about this subject (this document's runs)",
    ),
  /** Only the children of this run. */
  parentRunId: z.string().min(1).optional(),
  cursor: cursor.optional(),
  limit: pageLimit,
});

export const jobsOpsRunsSchema = z.object({
  runs: z.array(jobsOpsRunSummarySchema),
  nextCursor: z.string().nullable(),
});

export const jobsOpsRunInputSchema = z.object({ id: z.string().min(1) });

export const jobsOpsRunSchema = z.object({
  run: jobsOpsRunSummarySchema.extend({
    counts: itemCountsSchema.describe("The run's map steps' items, summed"),
    steps: z
      .array(
        stepStateSchema.extend({
          summary: z
            .string()
            .nullable()
            .describe(
              "A completed plain step's one line (its step's present); null for any other step, or with no view",
            ),
        }),
      )
      .describe(
        'Every step in order; a step of the current definition not yet started is pending',
      ),
  }),
  output: z
    .unknown()
    .nullable()
    .describe(
      "The job's output as stored (plain JSON) once completed; else null",
    ),
  outputUnreadable: z
    .boolean()
    .describe(
      'A completed run whose job is no longer registered, or whose output no longer parses',
    ),
  treeSpend: z
    .object({
      calls: count,
      inputTokens: count,
      costUsd: z.number().nonnegative(),
    })
    .describe(
      'The run and every descendant, every attempt once: the tree’s cost',
    ),
});

// ----- items -----

export const jobsOpsRunItemsInputSchema = z.object({
  runId: z.string().min(1),
  step: z.string().min(1).max(64),
  status: z.enum(ITEM_STATUSES).optional(),
  cursor: cursor.optional(),
  limit: pageLimit,
});

/**
 * How an item reads on the run page: what its step's `present` answers (`@pattern-stack/jobs`' `itemViewSchema`, restated here,
 * held equal at compile time by `@pattern-stack/jobs/nest`).
 */
export const jobsOpsItemViewSchema = z.object({
  label: z.string().min(1).max(200),
  summary: z.string().max(500).optional(),
  detail: z
    .array(
      z.object({
        heading: z.string().max(200),
        text: z.string().max(2000).optional(),
        quote: z.string().max(4000).optional(),
        refs: z
          .object({
            kind: z.string().min(1).max(64),
            ids: z.array(z.string().min(1).max(255)).min(1).max(50),
          })
          .optional()
          .describe(
            "Domain records the section shows by id; their labels come in the read's `records`",
          ),
      }),
    )
    .max(100)
    .optional(),
});

/**
 * A domain record a view names (a section's `refs`), as the host looked it up when the page read the view: its label
 * and quiet line from the source the kind's context registered, in the run's tenant. A named id with no record
 * here is not found (the tenant doesn't hold it, or no source reads the kind).
 */
export const jobsOpsViewRecordSchema = z.object({
  kind: z.string(),
  id: z.string().min(1),
  label: z.string(),
  hint: z.string().nullable(),
});

const viewRecords = z
  .array(jobsOpsViewRecordSchema)
  .describe(
    "The records the view's sections name, looked up now; empty when it names none",
  );

export const jobsOpsRunItemSchema = z.object({
  ordinal: count,
  chunkIndex: count.nullable().describe("Null for a children step's slot"),
  key: z.string(),
  ref: z.string().describe('An entity id, never content'),
  status: z.enum(ITEM_STATUSES),
  attempts: count,
  error: z
    .object({ kind: z.string(), message: z.string() })
    .nullable()
    .describe("A failed item's last error: its type and a fixed sentence"),
  result: z
    .unknown()
    .describe('The full stored result, as plain JSON; null when none'),
  view: jobsOpsItemViewSchema
    .nullable()
    .describe(
      "How the item reads (its step's present); null: no presenter, or it threw or answered outside the view schema",
    ),
  records: viewRecords,
});

export const jobsOpsRunItemsSchema = z.object({
  items: z
    .array(jobsOpsRunItemSchema)
    .describe('Failed items first, then the rest, each in planned order'),
  nextCursor: z.string().nullable(),
});

// ----- a step's output -----

export const jobsOpsStepOutputInputSchema = z.object({
  runId: z.string().min(1),
  step: z.string().min(1).max(64),
});

/**
 * How a plain step reads on the run page: what its `present` answers (`@pattern-stack/jobs`' `stepViewSchema`, restated here,
 * held equal at compile time by `@pattern-stack/jobs/nest`).
 */
export const jobsOpsStepViewSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).max(300),
  detail: jobsOpsItemViewSchema.shape.detail,
});

export const jobsOpsStepOutputSchema = z.object({
  view: jobsOpsStepViewSchema
    .nullable()
    .describe(
      'How the step reads (its present); null: no presenter, or it threw, answered null or outside the view schema',
    ),
  output: z
    .unknown()
    .describe(
      "The step's stored output, as plain JSON; null until it completed, or when it keeps none",
    ),
  error: z
    .object({ kind: z.string(), message: z.string() })
    .nullable()
    .describe("A failed step's error: its type and a fixed sentence"),
  records: viewRecords,
});

// ----- events -----

export const jobsOpsEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  jobKey: z.string(),
  type: z.enum(JOB_EVENT_TYPES),
  step: z.string().nullable(),
  attempt: count.nullable(),
  pauseReason: z.enum(PAUSE_REASONS).nullable(),
  errorType: z.string().nullable(),
  chunk: count.nullable().describe('step.retried: the chunk retried, if one'),
  itemKey: z.string().nullable().describe('item.failed: the failed item'),
  waitKind: z
    .enum(WAIT_KINDS)
    .nullable()
    .describe('step.waiting and step.woke: what the step waits on'),
  waitName: z
    .string()
    .nullable()
    .describe("step.waiting and step.woke: the gate's name"),
  counts: itemCountsSchema
    .nullable()
    .describe('step.progress and step.completed'),
  at: datetime,
});

export const jobsOpsRunEventsInputSchema = z.object({
  runId: z.string().min(1),
  cursor: cursor.optional(),
  limit: pageLimit,
});

export const jobsOpsEventsInputSchema = z.object({
  jobKey: z.string().min(1).max(128).optional(),
  tenantId: z.string().min(1).optional(),
  type: z.enum(JOB_EVENT_TYPES).optional(),
  cursor: cursor.optional(),
  limit: pageLimit,
});

export const jobsOpsEventsSchema = z.object({
  events: z
    .array(jobsOpsEventSchema)
    .describe("A run's events oldest first; the log's newest first"),
  nextCursor: z.string().nullable(),
});

// ----- actions -----

export const jobsOpsStartInputSchema = z.object({
  jobKey: z.string().min(1).max(128),
  tenantId: z.string().min(1),
  // Optional: a job that takes no input (`z.void()`) is started without one.
  input: z
    .unknown()
    .optional()
    .describe("The job's own input, parsed by its schema"),
  dryRun: z.boolean().default(false),
  cache: z
    .enum(CACHE_MODES)
    .optional()
    .describe(
      "refresh re-asks every item and overwrites the cache; omitted, the job's own choice for its input, else read-write",
    ),
  dedupeKey: z.string().regex(DEDUPE_KEY_PATTERN).optional(),
  budget: z
    .object({
      maxItems: count.optional(),
      maxUsd: z.number().nonnegative().optional(),
      maxCalls: count.optional(),
      maxDurationMs: count.optional(),
    })
    .default({})
    .describe(
      "An omitted field is the job's limit; maxItems is required for a job with no limits",
    ),
});

export const jobsOpsStartSchema = z.object({
  run: jobsOpsRunSummarySchema,
  created: z
    .boolean()
    .describe('false: an open run with the same dedupe key was returned'),
});

export const jobsOpsRunActionInputSchema = z.object({ runId: z.string().min(1) });

export const jobsOpsRunActionSchema = z.object({
  run: jobsOpsRunSummarySchema,
  changed: z
    .boolean()
    .describe("false: the run's status didn't allow it; it is shown as it is"),
});

// ----- signals -----

/** Approve: a signal for a run's waiting step, its value as the step's schema takes it. */
export const jobsOpsSignalInputSchema = z.object({
  runId: z.string().min(1),
  step: z.string().min(1).max(64),
  signal: z.string().min(1).max(128),
  value: z.unknown(),
});

export const jobsOpsSignalSchema = z.object({ run: jobsOpsRunSummarySchema });

/** Why a signal is refused, beside an `accept` refusal's own code. */
export const JOB_SIGNAL_REFUSALS = [
  'wait_not_open',
  'signal_value_invalid',
] as const;

// ----- children -----

/** Retry or Skip: a failed child's slot, named by its parent, its step and its key. */
export const jobsOpsChildActionInputSchema = z.object({
  runId: z.string().min(1).describe('The parent run'),
  step: z.string().min(1).max(64),
  key: z.string().min(1).max(255),
});

export const jobsOpsChildActionSchema = z.object({
  changed: z
    .boolean()
    .describe('false: the slot was not failed (another settled it first)'),
  childRunId: z
    .string()
    .nullable()
    .describe('The slot’s child now: a retry’s new run'),
});

// ----- ref lookups -----

/** At most this many options a lookup answers. */
export const JOB_REF_OPTIONS_MAX = 50;

export const jobsOpsRefOptionsInputSchema = z.object({
  ref: z.string().regex(JOB_REF_KIND_PATTERN),
  tenantId: z
    .string()
    .min(1)
    .describe("The form's tenant: every lookup is scoped to it"),
  q: z
    .string()
    .max(200)
    .optional()
    .describe('Words in the name; omitted lists the first ones'),
  limit: z.number().int().min(1).max(JOB_REF_OPTIONS_MAX).default(20),
});

export const jobsOpsRefOptionSchema = z.object({
  id: z.string().min(1).describe('What the input takes'),
  label: z.string(),
  hint: z
    .string()
    .nullable()
    .describe('A quiet line: the version, when it was published'),
});

export const jobsOpsRefOptionsSchema = z.object({
  options: z.array(jobsOpsRefOptionSchema),
});

export type JobsOpsRefOptionsInput = z.output<
  typeof jobsOpsRefOptionsInputSchema
>;
export type JobsOpsRefOption = z.output<typeof jobsOpsRefOptionSchema>;
export type JobsOpsRefOptions = z.output<typeof jobsOpsRefOptionsSchema>;

export type JobsOpsJob = z.output<typeof jobsOpsJobSchema>;
export type JobsOpsHealth = z.output<typeof jobsOpsHealthSchema>;
export type JobsOpsJobs = z.output<typeof jobsOpsJobsSchema>;
export type JobsOpsRunSubject = z.output<typeof jobsOpsRunSubjectSchema>;
export type JobsOpsRunSummary = z.output<typeof jobsOpsRunSummarySchema>;
export type JobsOpsRunsInput = z.output<typeof jobsOpsRunsInputSchema>;
export type JobsOpsRuns = z.output<typeof jobsOpsRunsSchema>;
export type JobsOpsRun = z.output<typeof jobsOpsRunSchema>;
export type JobsOpsRunItemsInput = z.output<typeof jobsOpsRunItemsInputSchema>;
export type JobsOpsRunItem = z.output<typeof jobsOpsRunItemSchema>;
export type JobsOpsItemView = z.output<typeof jobsOpsItemViewSchema>;
export type JobsOpsViewRecord = z.output<typeof jobsOpsViewRecordSchema>;
export type JobsOpsRunItems = z.output<typeof jobsOpsRunItemsSchema>;
export type JobsOpsStepOutputInput = z.output<
  typeof jobsOpsStepOutputInputSchema
>;
export type JobsOpsStepView = z.output<typeof jobsOpsStepViewSchema>;
export type JobsOpsStepOutput = z.output<typeof jobsOpsStepOutputSchema>;
export type JobsOpsEvent = z.output<typeof jobsOpsEventSchema>;
export type JobsOpsRunEventsInput = z.output<
  typeof jobsOpsRunEventsInputSchema
>;
export type JobsOpsEventsInput = z.output<typeof jobsOpsEventsInputSchema>;
export type JobsOpsEvents = z.output<typeof jobsOpsEventsSchema>;
export type JobsOpsStartInput = z.output<typeof jobsOpsStartInputSchema>;
export type JobsOpsStart = z.output<typeof jobsOpsStartSchema>;
export type JobsOpsRunAction = z.output<typeof jobsOpsRunActionSchema>;
export type JobsOpsSignalInput = z.output<typeof jobsOpsSignalInputSchema>;
export type JobsOpsSignal = z.output<typeof jobsOpsSignalSchema>;
export type JobsOpsSignalDescription = z.output<
  typeof jobsOpsSignalDescriptionSchema
>;
export type JobsOpsChildActionInput = z.output<
  typeof jobsOpsChildActionInputSchema
>;
export type JobsOpsChildAction = z.output<typeof jobsOpsChildActionSchema>;
