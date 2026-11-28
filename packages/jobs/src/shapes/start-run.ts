import { z } from 'zod';
import { defineShape } from './define-shape.ts';
import { runShape } from './run.ts';
import { CALLER_RUN_TRIGGERS, DEDUPE_KEY_PATTERN } from './vocabulary.ts';

const positiveInt = z.number().int().positive();

export const startRunRequestShape = defineShape(
  z.object({
    input: z
      .record(z.string(), z.unknown())
      .default({})
      .describe("The job's public input (Jobs<Key>Input)"),
    dryRun: z
      .boolean()
      .default(true)
      .describe('Read and decide, publish nothing; the default'),
    dedupeKey: z
      .string()
      .regex(DEDUPE_KEY_PATTERN)
      .optional()
      .describe(
        'At most one open run of this job per key in the tenant; a start with an open key returns that run',
      ),
    trigger: z.enum(CALLER_RUN_TRIGGERS).default('agent'),
    budget: z
      .object({
        maxItems: positiveInt.optional(),
        maxUsd: z.number().positive().optional(),
        maxCalls: positiveInt.optional(),
        maxDurationMs: positiveInt.optional(),
      })
      .default({})
      .describe("Each at most the job's limit; an omitted one is the limit"),
  }),
);

export const startRunResponseShape = defineShape(
  z.object({
    run: runShape,
    created: z
      .boolean()
      .describe('False when an open run with the same dedupe key was returned'),
  }),
);
