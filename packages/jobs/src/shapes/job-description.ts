import { z } from 'zod';
import { defineShape } from './define-shape.ts';
import {
  JOB_AUTHORITY_LEVELS,
  LIMITER_SCOPES,
  STEP_KINDS,
} from './vocabulary.ts';

const count = z.number().int().nonnegative();

const jobStepSchema = z.object({
  name: z.string(),
  kind: z.enum(STEP_KINDS),
  batchMax: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("A map step's items per call; null for a plain step"),
  limiters: z
    .array(
      z.object({
        name: z.string(),
        per: z
          .enum(LIMITER_SCOPES)
          .describe('One bucket for every run, or one per tenant'),
      }),
    )
    .describe(
      "The quotas a map step's calls draw on, or a plain step holds for its run; empty for none",
    ),
});

const authorityLevel = z.enum(JOB_AUTHORITY_LEVELS);

/** A public job as the API describes it: its steps, its public shapes, who may use it and its limits. */
export const jobDescriptionShape = defineShape(
  z.object({
    key: z.string().describe('The job key, as the run routes take it'),
    version: z
      .string()
      .describe('definitionVersion: a run reads against the version it ran'),
    steps: z.array(jobStepSchema),
    input: z
      .record(z.string(), z.unknown())
      .describe("JSON Schema (2020-12) of the job's public input, snake_case"),
    output: z
      .record(z.string(), z.unknown())
      .describe("JSON Schema (2020-12) of the job's public output, snake_case"),
    authority: z
      .object({
        read: authorityLevel.describe('Read its runs'),
        dryRun: authorityLevel.describe('Start and cancel a dry run'),
        start: authorityLevel.describe('Start and cancel a run that publishes'),
      })
      .describe(
        'The level each use needs, each level holding the ones below it: member (any named member) < tenant-wide (a tenant key acting as itself, with no acting member) < admin (a named member with tenant-admin authority)',
      ),
    limits: z
      .object({
        maxItems: count,
        maxUsd: z.number().nonnegative(),
        maxCalls: count,
        maxDurationMs: count,
      })
      .describe('The most one run may use; a start may ask for less'),
  }),
);

export const jobListShape = defineShape(
  z.object({ jobs: z.array(jobDescriptionShape) }),
);
