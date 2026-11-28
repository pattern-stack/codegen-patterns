/**
 * `@pattern-stack/jobs/bullmq`: the executor on BullMQ. The store is the truth; BullMQ only dispatches a run's advances and
 * its chunks. `bullmq` is an optional peer, so the core and its other entries never load it.
 */

export {
  BullmqExecutor,
  type BullmqExecutorOptions,
  type HandleOptions,
  type HandleOutcome,
} from './bullmq/bullmq-executor.ts';
export {
  type AdvanceJobData,
  type ChunkJobData,
  chunkJobId,
  JOB_ENGINE_JOBS,
  type JobEngineJob,
  type JobEngineJobData,
  type JobEngineQueue,
} from './bullmq/job-data.ts';
