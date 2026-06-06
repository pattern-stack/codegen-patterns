/**
 * Claim heartbeat (CLAIM-HB-1) — lease renewal for in-flight runs.
 *
 * The bug (dogfood-discovered, swe-brain 2026-06-06): `claimed_at` was stamped
 * once at claim and never renewed, while `sweepStaleClaims` reset any `running`
 * row whose `claimed_at` aged past `staleThresholdMs` (default 5 min) back to
 * `pending`. ANY handler that legitimately ran longer than the threshold was
 * silently re-queued mid-flight and re-claimed by a second worker, so the live
 * attempt and the zombie ran concurrently. A 365-day Gmail backfill could never
 * finish inside 5 min, so it re-spawned a fresh concurrent walk every ~6 min for
 * days.
 *
 * The fix: a live worker tracks the run IDs it has in flight and bumps
 * `claimed_at = now()` for them every `claimHeartbeatIntervalMs` (default
 * `staleThresholdMs / 3`). A long-but-alive run is therefore NEVER swept; only a
 * row whose worker DIED (renewal stops) ages out — the sweeper's documented
 * "stranded by a crashed worker" intent.
 *
 * These are unit tests: no Postgres. A stub Drizzle client records the renewal
 * UPDATE; the worker's timers are never started (we drive `renewClaims` /
 * `pollAndProcess` directly) so the tests are deterministic.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { drizzle } from 'drizzle-orm/pg-proxy';

import {
  JobWorker,
  type JobWorkerOptions,
  buildClaimRenewQuery,
} from '../../../../runtime/subsystems/jobs/job-worker';
import type { JobRunRow } from '../../../../runtime/subsystems/jobs/job-orchestration.schema';
import type { DrizzleClient } from '../../../../runtime/types/drizzle';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A no-op pg-proxy drizzle client, used only for `.toSQL()` inspection. */
function inspectableDb(): DrizzleClient {
  return drizzle(async () => ({ rows: [] })) as unknown as DrizzleClient;
}

/**
 * A stub Drizzle client that records every `update().set().where()` chain so a
 * test can assert what the heartbeat wrote. The chain is awaitable (the worker
 * `await`s the builder); awaiting resolves once the chain is recorded.
 */
function recordingDb(): {
  db: DrizzleClient;
  updates: Array<{ set: Record<string, unknown> }>;
} {
  const updates: Array<{ set: Record<string, unknown> }> = [];
  const db = {
    update() {
      const record: { set: Record<string, unknown> } = { set: {} };
      const chain = {
        set(values: Record<string, unknown>) {
          record.set = values;
          return chain;
        },
        where() {
          // The worker awaits the result of `.where(...)`; record on resolve.
          updates.push(record);
          return Promise.resolve(undefined);
        },
      };
      return chain;
    },
  } as unknown as DrizzleClient;
  return { db, updates };
}

/** Construct a JobWorker with a given db + options; timers are NOT started. */
function makeWorker(
  db: DrizzleClient,
  options: Partial<JobWorkerOptions> = {},
): JobWorker {
  const opts: JobWorkerOptions = {
    pool: 'batch',
    concurrency: 5,
    ...options,
  };
  return new JobWorker(
    db,
    {} as never,
    {} as never,
    {} as never,
    opts,
    {} as never,
  );
}

/** Read the private in-flight run-id set without widening source visibility. */
function inFlightRunIds(worker: JobWorker): Set<string> {
  return (worker as unknown as { inFlightRunIds: Set<string> }).inFlightRunIds;
}

/** Resolve the worker's effective heartbeat interval (private field). */
function heartbeatInterval(worker: JobWorker): number {
  return (worker as unknown as { claimHeartbeatIntervalMs: number })
    .claimHeartbeatIntervalMs;
}

// ─── 1. buildClaimRenewQuery — SQL invariants ─────────────────────────────────

describe('buildClaimRenewQuery — SQL invariants', () => {
  const db = inspectableDb();
  const { sql, params } = buildClaimRenewQuery(
    db,
    ['run-a', 'run-b'],
    new Date('2026-06-06T00:00:00.000Z'),
  ).toSQL();
  const normalised = sql.toUpperCase().replace(/\s+/g, ' ');

  it('UPDATEs job_run setting claimed_at (the lease renewal)', () => {
    expect(normalised).toContain('UPDATE');
    expect(normalised).toContain('"CLAIMED_AT" =');
  });

  it('also bumps updated_at', () => {
    expect(normalised).toContain('"UPDATED_AT" =');
  });

  it('scopes to the supplied run ids', () => {
    expect(normalised).toContain('"ID" IN');
    expect(params).toContain('run-a');
    expect(params).toContain('run-b');
  });

  it('guards on status = running so a swept-and-reclaimed run is untouched', () => {
    expect(normalised).toContain('"STATUS" =');
    expect(params).toContain('running');
  });
});

// ─── 2. renewClaims — issues an UPDATE only for in-flight runs ─────────────────

describe('JobWorker.renewClaims — lease renewal', () => {
  it('no-ops (no UPDATE) when nothing is in flight', async () => {
    const { db, updates } = recordingDb();
    const worker = makeWorker(db);
    await worker.renewClaims();
    expect(updates.length).toBe(0);
  });

  it('issues exactly one UPDATE bumping claimed_at for the in-flight runs', async () => {
    const { db, updates } = recordingDb();
    const worker = makeWorker(db);
    inFlightRunIds(worker).add('run-1');
    inFlightRunIds(worker).add('run-2');

    await worker.renewClaims();

    expect(updates.length).toBe(1);
    expect(updates[0]?.set.claimedAt).toBeInstanceOf(Date);
    expect(updates[0]?.set.updatedAt).toBeInstanceOf(Date);
  });

  it('does not renew once shutting down', async () => {
    const { db, updates } = recordingDb();
    const worker = makeWorker(db);
    inFlightRunIds(worker).add('run-1');
    (worker as unknown as { shuttingDown: boolean }).shuttingDown = true;

    await worker.renewClaims();
    expect(updates.length).toBe(0);
  });
});

// ─── 3. Heartbeat interval defaulting ─────────────────────────────────────────

describe('JobWorker — claimHeartbeatIntervalMs defaulting', () => {
  it('defaults to staleThresholdMs / 3 so a run survives two missed beats', () => {
    const worker = makeWorker(inspectableDb(), { staleThresholdMs: 300_000 });
    expect(heartbeatInterval(worker)).toBe(100_000);
  });

  it('honors an explicit consumer-supplied interval verbatim', () => {
    const worker = makeWorker(inspectableDb(), {
      staleThresholdMs: 300_000,
      claimHeartbeatIntervalMs: 15_000,
    });
    expect(heartbeatInterval(worker)).toBe(15_000);
  });

  it('is always at least 1ms even at a pathologically small threshold', () => {
    const worker = makeWorker(inspectableDb(), { staleThresholdMs: 1 });
    expect(heartbeatInterval(worker)).toBeGreaterThanOrEqual(1);
  });
});

// ─── 4. In-flight lifecycle — registered while running, cleared on settle ─────

describe('JobWorker — in-flight run-id lifecycle (heartbeat scope)', () => {
  /**
   * Drive `pollAndProcess` with a stubbed `claimNext` (returns one run) and a
   * controllable `processRun` (a deferred promise). This is the exact wrapper
   * under test: the run id must be in the renew set WHILE the handler runs (so a
   * long handler keeps getting its lease renewed and is never swept) and gone
   * once execution settles (so the heartbeat stops touching a run this worker no
   * longer owns).
   */
  function makeLifecycleWorker(): {
    worker: JobWorker;
    resolveRun: () => void;
    rejectRun: (e: unknown) => void;
    processStarted: Promise<void>;
  } {
    const worker = makeWorker(inspectableDb());
    const run = { id: 'run-long' } as unknown as JobRunRow;

    // Always hand back the same run on the first claim, then nothing.
    let claimed = false;
    (worker as unknown as { claimNext: () => Promise<JobRunRow | null> }).claimNext =
      async () => {
        if (claimed) return null;
        claimed = true;
        return run;
      };

    let resolveRun!: () => void;
    let rejectRun!: (e: unknown) => void;
    let markStarted!: () => void;
    const processStarted = new Promise<void>((res) => {
      markStarted = res;
    });
    const settle = new Promise<void>((res, rej) => {
      resolveRun = () => res();
      rejectRun = (e) => rej(e);
    });
    (worker as unknown as { processRun: (r: JobRunRow) => Promise<void> }).processRun =
      async () => {
        markStarted();
        await settle;
      };

    return { worker, resolveRun, rejectRun, processStarted };
  }

  it('registers the run while the handler runs, so a long run stays renewable', async () => {
    const { worker, resolveRun, processStarted } = makeLifecycleWorker();

    await worker.pollAndProcess();
    await processStarted;

    // Handler is "still running" (settle not resolved) — its lease must renew.
    expect(inFlightRunIds(worker).has('run-long')).toBe(true);

    resolveRun();
    // Let the finally hooks flush.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(inFlightRunIds(worker).has('run-long')).toBe(false);
  });

  it('clears the run from the renew set after a SUCCESSFUL settle', async () => {
    const { worker, resolveRun, processStarted } = makeLifecycleWorker();
    await worker.pollAndProcess();
    await processStarted;
    resolveRun();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(inFlightRunIds(worker).size).toBe(0);
  });

  it('clears the run from the renew set even when processRun THROWS', async () => {
    const { worker, rejectRun, processStarted } = makeLifecycleWorker();
    await worker.pollAndProcess();
    await processStarted;
    rejectRun(new Error('handler blew up'));
    await new Promise<void>((r) => setTimeout(r, 0));
    // The unhandled-error catch + finally must still deregister the id, so the
    // heartbeat never keeps bumping a run this worker no longer owns.
    expect(inFlightRunIds(worker).has('run-long')).toBe(false);
  });
});
