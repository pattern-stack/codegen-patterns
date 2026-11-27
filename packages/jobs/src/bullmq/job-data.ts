import { createHash } from 'node:crypto';
import type { JobsOptions } from 'bullmq';
import type { Chunk } from '../model/chunk.ts';

/** The two job names the engine's queue runs: one run's step loop, and one chunk. */
export const JOB_ENGINE_JOBS = { advance: 'advance', chunk: 'chunk' } as const;

export interface AdvanceJobData {
  runId: string;
  /** The run's own trace root (none on a submit or a sweep), carried verbatim to every job its handling enqueues. */
  workflowContext?: unknown;
}

export interface ChunkJobData {
  runId: string;
  step: string;
  index: number;
  workflowContext?: unknown;
}

export type JobEngineJobData = AdvanceJobData | ChunkJobData;

/** What the executor reads of a BullMQ job: its name and data. */
export interface JobEngineJob {
  name: string;
  data: JobEngineJobData;
}

/** What the executor needs of a BullMQ queue: `add`. A `Queue<JobEngineJobData>` fits. */
export interface JobEngineQueue {
  add(
    name: string,
    data: JobEngineJobData,
    opts?: JobsOptions,
  ): Promise<unknown>;
}

export const isChunkJob = (data: JobEngineJobData): data is ChunkJobData =>
  'step' in data;

/**
 * A chunk dispatch's job id: the chunk and its attempts, hashed. A repeated dispatch of the same attempt is a no-op
 * while that job waits or runs; a retried or swept chunk (one more attempt) gets a fresh job. BullMQ refuses a custom
 * id with `:`, so the prefix is joined by `-`.
 */
export const chunkJobId = (
  c: Pick<Chunk, 'runId' | 'step' | 'index' | 'attempts'>,
): string =>
  `chunk-${createHash('sha1').update(`${c.runId}/${c.step}#${c.index}@${c.attempts}`).digest('hex')}`;

/** Retries have one owner, the engine: BullMQ runs each job once and keeps nothing. */
export const ONCE: JobsOptions = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
};

/** At most one advance per run active and one waiting; a submit that lands mid-advance becomes the next one. */
export const advanceOptions = (runId: string): JobsOptions => ({
  ...ONCE,
  deduplication: { id: `advance-${runId}`, keepLastIfActive: true },
});
