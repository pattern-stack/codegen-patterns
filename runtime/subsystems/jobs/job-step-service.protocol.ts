/**
 * IJobStepService — record and fetch `job_step` rows for step-level
 * memoization and replay (ADR-022, JOB-2).
 *
 * `ctx.step(id, fn)` in `JobHandlerBase` goes through this service:
 * check for an existing `completed` row (memo hit, return `output`),
 * otherwise record `running`, `await fn()`, terminal-state the row.
 */
import type { JobStepRow } from './job-orchestration.schema';

export type JobStep = JobStepRow;

export interface RecordStepInput {
  jobRunId: string;
  stepId: string;
  /**
   * `'task'` is the only value in `jobStepKindEnum` today; ADR-027 widens
   * to include `tool_call | llm_call | wait | checkpoint | message`. The
   * literal here intentionally mirrors the enum tuple in JOB-1.
   */
  kind: 'task';
  seq: number;
  input?: unknown;
  output?: unknown;
  error?: {
    message: string;
    stack?: string;
    retryable: boolean;
    attempt: number;
  };
  /**
   * Must match the `jobStepStatusEnum` value tuple from JOB-1. Kept as a
   * literal union here rather than `typeof jobStepStatusEnum.enumValues[number]`
   * so protocol consumers don't need to import the schema module.
   */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: Date;
  finishedAt?: Date;
  attempts?: number;
}

export interface IJobStepService {
  /**
   * Insert or update a `job_step` row. Backend implementations upsert on
   * `(job_run_id, step_id)` — the `idx_job_step_run_step` unique index.
   */
  recordStep(input: RecordStepInput): Promise<JobStep>;

  /**
   * Lookup for memoization. Returns `null` when no prior row exists.
   */
  findStep(runId: string, stepId: string): Promise<JobStep | null>;
}
