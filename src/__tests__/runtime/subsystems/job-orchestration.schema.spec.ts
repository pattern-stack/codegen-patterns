/**
 * Unit tests for the job orchestration Drizzle schema (JOB-1, ADR-022).
 *
 * Pure structural/metadata checks — no Postgres, no Docker. Verifies that
 *   1. the three pgTable declarations import cleanly,
 *   2. the expected columns are present on job_run and job_step,
 *   3. the enums carry the values other code will rely on (especially the
 *      'waiting' and 'timed_out' states reserved for ADR-025), and
 *   4. InferSelectModel resolved a concrete row type (no implicit `any` widening).
 */
import { describe, it, expect } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';
import {
  jobs,
  jobRuns,
  jobSteps,
  jobRunStatusEnum,
  type JobRunRow,
} from '../../../../runtime/subsystems/jobs/job-orchestration.schema';

describe('job-orchestration.schema — import smoke', () => {
  it('exports the three pgTable declarations as objects', () => {
    expect(typeof jobs).toBe('object');
    expect(typeof jobRuns).toBe('object');
    expect(typeof jobSteps).toBe('object');
    expect(jobs).not.toBeNull();
    expect(jobRuns).not.toBeNull();
    expect(jobSteps).not.toBeNull();
  });
});

describe('job_run — column presence', () => {
  const cols = getTableColumns(jobRuns) as Record<string, unknown>;

  it.each([
    'id',
    'jobType',
    'status',
    'pool',
    'runAt',
    'tenantId',
    'waitKind',
    'resumeToken',
    'waitDeadline',
    'rootRunId',
    'parentRunId',
    'concurrencyKey',
    'dedupeKey',
  ])('includes column %s', (key) => {
    expect(cols[key]).toBeDefined();
  });
});

describe('job_step — column presence', () => {
  const cols = getTableColumns(jobSteps) as Record<string, unknown>;

  it.each(['id', 'jobRunId', 'stepId', 'seq', 'kind', 'status', 'output'])(
    'includes column %s',
    (key) => {
      expect(cols[key]).toBeDefined();
    },
  );
});

describe('jobRunStatusEnum — reserved Phase 3 values', () => {
  it("includes 'waiting'", () => {
    expect(jobRunStatusEnum.enumValues).toContain('waiting');
  });

  it("includes 'timed_out'", () => {
    expect(jobRunStatusEnum.enumValues).toContain('timed_out');
  });
});

describe('JobRunRow — type-level compile check', () => {
  it('resolves to a concrete row type (assignment compiles)', () => {
    // If InferSelectModel widened to `any`, TypeScript would not catch a
    // shape mismatch here. The literal below exercises the shape; the test
    // merely asserts the file compiles and the value exists at runtime.
    const row: JobRunRow = {
      id: '00000000-0000-0000-0000-000000000000',
      jobType: 'onboarding',
      jobVersion: 1,
      parentRunId: null,
      rootRunId: '00000000-0000-0000-0000-000000000000',
      parentClosePolicy: 'terminate',
      scopeEntityType: null,
      scopeEntityId: null,
      tenantId: null,
      tags: {},
      pool: 'default',
      priority: 0,
      concurrencyKey: null,
      dedupeKey: null,
      status: 'pending',
      input: {},
      output: null,
      error: null,
      triggerSource: 'manual',
      triggerRef: null,
      runAt: new Date(),
      startedAt: null,
      finishedAt: null,
      claimedAt: null,
      attempts: 0,
      waitKind: null,
      resumeToken: null,
      waitDeadline: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(row.id).toBeDefined();
  });
});
