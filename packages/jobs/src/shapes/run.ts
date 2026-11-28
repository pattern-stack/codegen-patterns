import { z } from 'zod';
import { defineShape } from './define-shape.ts';
import {
  PAUSE_REASONS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  STEP_KINDS,
  STEP_STATUSES,
  WAIT_KINDS,
} from './vocabulary.ts';

const count = z.number().int().nonnegative();
const datetime = z.iso.datetime();

/** A run's or a step's error on the wire: its type and a fixed sentence, never the stored or provider text. */
export const runErrorSchema = z.object({
  type: z.string().max(64).describe("The error's type, e.g. RunPlanningError"),
  message: z
    .string()
    .describe(
      'A fixed sentence for the type; never the stored or provider text',
    ),
});

/** A map step's items by state; zeros for a plain step. */
export const itemCountsSchema = z.object({
  total: count,
  done: count,
  cached: count,
  failed: count,
  skipped: count,
});

export const stepStateSchema = z.object({
  name: z.string(),
  index: count,
  kind: z.enum(STEP_KINDS),
  status: z.enum(STEP_STATUSES),
  attempts: count,
  counts: itemCountsSchema,
  speculation: z
    .object({ speculated: count, used: count, overshoot: count })
    .nullable()
    .describe('Items run past an early stop, for a map step with stopWhen'),
  wait: z
    .object({
      kind: z.enum(WAIT_KINDS),
      name: z.string().describe("The gate's name: a code constant"),
      since: datetime,
      wakeAt: datetime
        .nullable()
        .describe('When the run looks again; null once the wait settled'),
    })
    .nullable()
    .describe('What the step waits on, or waited on; null if it never waited'),
  error: runErrorSchema.nullable(),
  startedAt: datetime.nullable(),
  completedAt: datetime.nullable(),
});

/** The run record's fields, shared with the operator surface (`ops.ts`). */
export const runSummaryFields = {
  id: z.string().min(1),
  jobKey: z.string(),
  jobVersion: z.string(),
  status: z.enum(RUN_STATUSES),
  pauseReason: z.enum(PAUSE_REASONS).nullable(),
  trigger: z.enum(RUN_TRIGGERS),
  dryRun: z.boolean(),
  requestedBy: z
    .string()
    .min(1)
    .nullable()
    .describe('The acting member; null when a tenant key started it'),
  dedupeKey: z.string().nullable(),
  budget: z.object({
    maxItems: count,
    maxUsd: z.number().nonnegative().nullable(),
    maxCalls: count.nullable(),
    deadlineAt: datetime.nullable(),
  }),
  spend: z.object({
    calls: count,
    inputTokens: count,
    costUsd: z.number().nonnegative(),
  }),
  error: runErrorSchema.nullable(),
  createdAt: datetime,
  startedAt: datetime.nullable(),
  completedAt: datetime.nullable(),
};

/** A list row: the run record alone. */
export const runSummaryShape = defineShape(z.object(runSummaryFields));

/** One run, its steps and its output. */
export const runShape = defineShape(
  z.object({
    ...runSummaryFields,
    counts: itemCountsSchema.describe("The run's map steps' items, summed"),
    steps: z
      .array(stepStateSchema)
      .describe(
        'Every step of the definition, in order; a step not yet started is pending',
      ),
    output: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        "The job's public output (its Jobs<Key>Output) once completed; else null",
      ),
    revision: z
      .string()
      .describe(
        'Changes whenever anything above but output changes; pass it to wait as after',
      ),
  }),
);

export const runPageShape = defineShape(
  z.object({
    runs: z.array(runSummaryShape),
    nextCursor: z
      .string()
      .nullable()
      .describe('Pass as cursor for the next page; null on the last'),
  }),
);
