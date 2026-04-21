/**
 * MemoryRunRecorder — in-memory backend for `ISyncRunRecorder` (SYNC-6).
 *
 * Test double so `SyncModule.forRoot({ backend: 'memory' })` is genuinely
 * end-to-end runnable without Postgres. Mirrors the role of
 * `MemoryCursorStore`: plain keyed state, `clear()` helper for
 * `beforeEach` resets, public inspection surface so tests can assert on
 * the recorded run + item timeline without scraping logs.
 *
 * Validates `changedFields` through `FieldDiffSchema.parse` on every
 * `recordItem` call — same ADR-0003 contract as the Drizzle backend. An
 * in-memory recorder that skipped the validation would be a silently
 * weaker contract than production.
 *
 * `startRun` generates a uuid via `crypto.randomUUID()` (Node 19+ / Bun).
 * We don't import `uuid` because the subsystem has no other use for it.
 *
 * ## Multi-tenancy
 *
 * `tenantId` is accepted (and recorded on the in-memory row so tests can
 * assert it) but enforcement lives at the module boundary. The memory
 * backend intentionally does not throw on missing `tenantId` — that's
 * the orchestrator's job when `multiTenant=true` (SYNC-6). A permissive
 * memory recorder lets tests exercise error paths where the orchestrator
 * short-circuits before ever reaching the recorder.
 */
import { Injectable } from '@nestjs/common';
import type {
  CompleteRunInput,
  ISyncRunRecorder,
  RecordItemInput,
  StartRunInput,
} from './sync-run-recorder.protocol';
import { FieldDiffSchema } from './sync-field-diff.protocol';

/**
 * Concrete run row as held in memory. Shape mirrors the interesting
 * columns on `sync_runs` so assertions read like DB queries.
 */
export interface MemoryRunRecord {
  id: string;
  subscriptionId: string;
  direction: 'inbound' | 'outbound';
  action: 'poll' | 'cdc' | 'webhook' | 'manual' | 'writeback';
  status: 'running' | 'success' | 'no_changes' | 'failed';
  cursorBefore: unknown | null;
  cursorAfter: unknown | null;
  recordsFound: number;
  recordsProcessed: number;
  durationMs: number | null;
  error: string | null;
  tenantId: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

@Injectable()
export class MemoryRunRecorder implements ISyncRunRecorder {
  /**
   * All started runs keyed by id. Public so tests can inspect lifecycle
   * transitions without poking through recording methods.
   */
  readonly runs: Map<string, MemoryRunRecord> = new Map();

  /**
   * Items keyed by `sync_run_id`, array order matches insertion order —
   * mirrors the timeline the `(sync_run_id, created_at)` index produces
   * in Postgres.
   */
  readonly items: Map<string, RecordItemInput[]> = new Map();

  async startRun(input: StartRunInput): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    this.runs.set(id, {
      id,
      subscriptionId: input.subscriptionId,
      direction: input.direction,
      action: input.action,
      status: 'running',
      cursorBefore: input.cursorBefore ?? null,
      cursorAfter: null,
      recordsFound: 0,
      recordsProcessed: 0,
      durationMs: null,
      error: null,
      tenantId: input.tenantId ?? null,
      startedAt: new Date(),
      completedAt: null,
    });
    this.items.set(id, []);
    return { id };
  }

  async recordItem(input: RecordItemInput): Promise<void> {
    // Same ADR-0003 contract as the Drizzle backend.
    FieldDiffSchema.parse(input.changedFields);

    const bucket = this.items.get(input.syncRunId);
    if (!bucket) {
      throw new Error(
        `MemoryRunRecorder.recordItem: no run started for id '${input.syncRunId}'. ` +
          `Call startRun(...) first.`,
      );
    }
    bucket.push(input);
  }

  async completeRun(runId: string, input: CompleteRunInput): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(
        `MemoryRunRecorder.completeRun: no run started for id '${runId}'.`,
      );
    }
    run.status = input.status;
    run.recordsFound = input.recordsFound;
    run.recordsProcessed = input.recordsProcessed;
    run.cursorAfter = input.cursorAfter ?? null;
    run.durationMs = input.durationMs;
    run.error = input.error ?? null;
    run.completedAt = new Date();
  }

  /** Reset state. Tests call this in `beforeEach`. */
  clear(): void {
    this.runs.clear();
    this.items.clear();
  }

  // ─── test ergonomics ─────────────────────────────────────────────────

  /** All runs for a subscription, newest first. Timeline reads. */
  getRunsForSubscription(subscriptionId: string): MemoryRunRecord[] {
    return Array.from(this.runs.values())
      .filter((r) => r.subscriptionId === subscriptionId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  /** All item rows for a run, insertion-ordered. */
  getItemsForRun(runId: string): RecordItemInput[] {
    return this.items.get(runId) ?? [];
  }
}
