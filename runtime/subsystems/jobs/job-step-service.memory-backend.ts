/**
 * MemoryJobStepService — in-memory implementation of `IJobStepService`
 * (ADR-022, JOB-4).
 *
 * Mirrors `DrizzleJobStepService` but against plain Maps. `findStep` only
 * returns `completed` rows (memoization cache hit); anything non-completed
 * is invisible so the ctx.step fn re-runs on replay / retry exactly like
 * the Drizzle backend (which deletes non-completed rows on replay).
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { JobStepRow } from './job-orchestration.schema';
import type {
  IJobStepService,
  JobStep,
  RecordStepInput,
} from './job-step-service.protocol';
import { MemoryJobStore } from './memory-job-store';

@Injectable()
export class MemoryJobStepService implements IJobStepService {
  constructor(private readonly store: MemoryJobStore) {}

  async findStep(runId: string, stepId: string): Promise<JobStep | null> {
    const rows = this.store.steps.get(runId);
    if (!rows) return null;
    const match = rows.find(
      (r) => r.stepId === stepId && r.status === 'completed',
    );
    return (match ?? null) as JobStep | null;
  }

  async recordStep(input: RecordStepInput): Promise<JobStep> {
    const rows = this.getOrCreateRows(input.jobRunId);
    const existingIdx = rows.findIndex((r) => r.stepId === input.stepId);

    const normalisedInput =
      (input.input ?? null) as Record<string, unknown> | null;
    const normalisedOutput =
      (input.output ?? null) as Record<string, unknown> | null;

    if (existingIdx >= 0) {
      const prev = rows[existingIdx]!;
      const next: JobStepRow = {
        ...prev,
        status: input.status,
        input: normalisedInput ?? prev.input,
        output: normalisedOutput ?? prev.output,
        error: input.error ?? prev.error,
        attempts: input.attempts ?? prev.attempts,
        startedAt: input.startedAt ?? prev.startedAt,
        finishedAt: input.finishedAt ?? prev.finishedAt,
      };
      rows[existingIdx] = next;
      return next as JobStep;
    }

    const seq = input.seq ?? this.nextSeq(rows);
    const row: JobStepRow = {
      id: randomUUID(),
      jobRunId: input.jobRunId,
      stepId: input.stepId,
      kind: input.kind,
      seq,
      status: input.status,
      input: normalisedInput,
      output: normalisedOutput,
      error: input.error ?? null,
      attempts: input.attempts ?? 0,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
    };
    rows.push(row);
    return row as JobStep;
  }

  /**
   * Replay helper — wipe every step row for a run. Mirrors the `scratch`
   * replay mode of the Drizzle backend (`DELETE FROM job_step WHERE job_run_id = …`).
   */
  clearStepsForRun(runId: string): void {
    this.store.steps.delete(runId);
  }

  /**
   * Remove every non-`completed` row for the run. Memoized (`completed`)
   * rows are preserved — this is the `last_checkpoint` / `last_step`
   * semantics the Drizzle backend implements via
   * `DELETE … WHERE status != 'completed'`. Both replay modes route here
   * (Phase 1 collapses `last_step` onto this behaviour; see JOB-3 notes).
   */
  clearIncompleteSteps(runId: string): void {
    const rows = this.store.steps.get(runId);
    if (!rows) return;
    const kept = rows.filter((r) => r.status === 'completed');
    if (kept.length === 0) {
      this.store.steps.delete(runId);
    } else {
      this.store.steps.set(runId, kept);
    }
  }

  private getOrCreateRows(runId: string): JobStepRow[] {
    let rows = this.store.steps.get(runId);
    if (!rows) {
      rows = [];
      this.store.steps.set(runId, rows);
    }
    return rows;
  }

  private nextSeq(rows: JobStepRow[]): number {
    let max = 0;
    for (const r of rows) {
      if (r.seq > max) max = r.seq;
    }
    return max + 1;
  }
}
