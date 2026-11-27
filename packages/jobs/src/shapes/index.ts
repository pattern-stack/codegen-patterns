/** `@pattern-stack/jobs/shapes`: the jobs API's wire shapes (camelCase, published in snake_case) and their vocabulary. */

export { jobDescriptionShape, jobListShape } from './job-description.ts';
export { runListQueryShape, runWaitQueryShape } from './reads.ts';
export {
  itemCountsSchema,
  runErrorSchema,
  runPageShape,
  runShape,
  runSummaryShape,
  stepStateSchema,
} from './run.ts';
export { startRunRequestShape, startRunResponseShape } from './start-run.ts';
export * from './vocabulary.ts';

import type { z } from 'zod';
import type { jobDescriptionShape, jobListShape } from './job-description.ts';
import type { runListQueryShape, runWaitQueryShape } from './reads.ts';
import type { runPageShape, runShape, runSummaryShape } from './run.ts';
import type {
  startRunRequestShape,
  startRunResponseShape,
} from './start-run.ts';

/** The shapes' camelCase values, as the service speaks them. */
export type JobDescriptionValue = z.output<typeof jobDescriptionShape>;
export type JobListValue = z.output<typeof jobListShape>;
export type RunValue = z.output<typeof runShape>;
export type RunSummaryValue = z.output<typeof runSummaryShape>;
export type RunPageValue = z.output<typeof runPageShape>;
export type StartRunRequestValue = z.output<typeof startRunRequestShape>;
export type StartRunResponseValue = z.output<typeof startRunResponseShape>;
export type RunListQueryValue = z.output<typeof runListQueryShape>;
export type RunWaitQueryValue = z.output<typeof runWaitQueryShape>;
