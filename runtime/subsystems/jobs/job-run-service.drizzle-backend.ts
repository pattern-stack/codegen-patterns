/**
 * DrizzleJobRunService — scope-oriented reads and bulk operations against
 * `job_run` (ADR-022, JOB-3).
 *
 * Separate from the orchestrator because the access pattern differs: this
 * service scans by `(scope_entity_type, scope_entity_id)` via
 * `idx_job_run_scope`, whereas orchestrator mutates individual runs by id.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '../../types/drizzle';
import { DRIZZLE } from '../../constants/tokens';
import { jobRuns, type JobRunRow } from './job-orchestration.schema';
import type { JobRun } from './job-orchestrator.protocol';
import type {
  IJobRunService,
  ListForScopeOptions,
} from './job-run-service.protocol';
import type { IJobOrchestrator } from './job-orchestrator.protocol';
import { JOB_ORCHESTRATOR } from './jobs-domain.tokens';

const NON_TERMINAL_STATUSES: JobRunRow['status'][] = [
  'pending',
  'running',
  'waiting',
];

@Injectable()
export class DrizzleJobRunService implements IJobRunService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    @Inject(JOB_ORCHESTRATOR) private readonly orchestrator: IJobOrchestrator,
  ) {}

  async listForScope(
    entityType: string,
    entityId: string,
    opts: ListForScopeOptions = {},
  ): Promise<JobRun[]> {
    const conditions = [
      eq(jobRuns.scopeEntityType, entityType),
      eq(jobRuns.scopeEntityId, entityId),
    ];
    if (opts.status) {
      if (Array.isArray(opts.status)) {
        conditions.push(inArray(jobRuns.status, opts.status));
      } else {
        conditions.push(eq(jobRuns.status, opts.status));
      }
    }
    if (opts.jobType) {
      conditions.push(eq(jobRuns.jobType, opts.jobType));
    }

    const orderCol = (() => {
      switch (opts.orderBy) {
        case 'created_at asc':
          return asc(jobRuns.createdAt);
        case 'run_at desc':
          return desc(jobRuns.runAt);
        case 'run_at asc':
          return asc(jobRuns.runAt);
        case 'created_at desc':
        default:
          return desc(jobRuns.createdAt);
      }
    })();

    let q = this.db
      .select()
      .from(jobRuns)
      .where(and(...conditions))
      .orderBy(orderCol)
      .$dynamic();

    if (typeof opts.limit === 'number') {
      q = q.limit(opts.limit);
    }
    if (typeof opts.offset === 'number') {
      q = q.offset(opts.offset);
    }

    const rows = await q;
    return rows as JobRun[];
  }

  async cancelForScope(entityType: string, entityId: string): Promise<void> {
    const rows = await this.db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .where(
        and(
          eq(jobRuns.scopeEntityType, entityType),
          eq(jobRuns.scopeEntityId, entityId),
          inArray(jobRuns.status, NON_TERMINAL_STATUSES),
        ),
      );

    for (const { id } of rows) {
      await this.orchestrator.cancel(id, { cascade: true });
    }
  }

  async rescheduleForScope(
    entityType: string,
    entityId: string,
    newRunAt: Date,
  ): Promise<void> {
    await this.db
      .update(jobRuns)
      .set({ runAt: newRunAt, updatedAt: new Date() })
      .where(
        and(
          eq(jobRuns.scopeEntityType, entityType),
          eq(jobRuns.scopeEntityId, entityId),
          eq(jobRuns.status, 'pending'),
        ),
      );
  }

  /**
   * Internal helper used by cascade paths (not on the public protocol).
   * Exposed as a public method on the concrete class so infrastructure
   * code (cascade tests, debug tools) can call it without a cast.
   */
  async findByRootRunId(rootRunId: string): Promise<JobRun[]> {
    const rows = await this.db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.rootRunId, rootRunId));
    return rows as JobRun[];
  }
}
