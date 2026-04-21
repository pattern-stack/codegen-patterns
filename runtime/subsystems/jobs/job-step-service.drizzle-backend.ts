/**
 * DrizzleJobStepService — upsert + lookup on `job_step` for replay-safe
 * memoization (ADR-022, JOB-3).
 *
 * `recordStep` upserts on the `(job_run_id, step_id)` unique index — each
 * step row is written as `running` first, then transitioned to a terminal
 * state (`completed` / `failed` / `skipped`). `findStep` is the hot path
 * that `ctx.step()` consults on every invocation; null on miss.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '../../types/drizzle';
import { DRIZZLE } from '../../constants/tokens';
import { jobSteps, type JobStepRow } from './job-orchestration.schema';
import type {
  IJobStepService,
  JobStep,
  RecordStepInput,
} from './job-step-service.protocol';

@Injectable()
export class DrizzleJobStepService implements IJobStepService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleClient) {}

  async recordStep(input: RecordStepInput): Promise<JobStep> {
    const values = {
      jobRunId: input.jobRunId,
      stepId: input.stepId,
      kind: input.kind,
      seq: input.seq,
      status: input.status,
      input: (input.input ?? null) as Record<string, unknown> | null,
      output: (input.output ?? null) as Record<string, unknown> | null,
      error: input.error ?? null,
      attempts: input.attempts ?? 0,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
    };

    const [row] = await this.db
      .insert(jobSteps)
      .values(values)
      .onConflictDoUpdate({
        target: [jobSteps.jobRunId, jobSteps.stepId],
        set: {
          status: values.status,
          output: values.output,
          error: values.error,
          finishedAt: values.finishedAt,
          attempts: values.attempts,
        },
      })
      .returning();

    return row as JobStep;
  }

  async findStep(runId: string, stepId: string): Promise<JobStep | null> {
    const [row] = await this.db
      .select()
      .from(jobSteps)
      .where(and(eq(jobSteps.jobRunId, runId), eq(jobSteps.stepId, stepId)))
      .limit(1);
    return ((row as JobStepRow | undefined) ?? null) as JobStep | null;
  }
}
