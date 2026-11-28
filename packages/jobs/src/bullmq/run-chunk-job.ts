import { abortsInFlight } from '../engine/heartbeat.ts';
import { type ChunkOutcome, processChunk } from '../engine/process-chunk.ts';
import { ClaimLostError } from '../model/errors.ts';
import { inScope } from '../ports/run-scope.ts';
import type { ChunkJobData } from './job-data.ts';
import type { JobEngineRuntime } from './runtime.ts';

/**
 * The worker side of one chunk: claim it by name (null when it is settled, held or not yet due: skipped), process it
 * with a heartbeat that renews the claim (a lost claim, a cancel or a failure aborts it; a pause lets its calls finish), then submit the run again so it
 * reads its early stop, completes the step, or dispatches a retry after its backoff.
 */
export async function runChunkJob(
  rt: JobEngineRuntime,
  data: ChunkJobData,
  carried: unknown,
): Promise<ChunkOutcome | 'skipped'> {
  const claim = await rt.store.claimChunk(rt.owner, rt.claimTtlMs, {
    runId: data.runId,
    step: data.step,
    index: data.index,
  });
  if (!claim) return 'skipped';
  const controller = new AbortController();
  const release = rt.track(controller);
  const beat = setInterval(
    () =>
      void rt.store
        .renewClaim(rt.owner, [claim], rt.claimTtlMs)
        .then((report) => {
          // Matched by value (chunk and token), never by identity: a store may rebuild claims from rows.
          const lost = report.lost.some(
            (l) =>
              l.runId === claim.runId &&
              l.step === claim.step &&
              l.index === claim.index &&
              l.token === claim.token,
          );
          if (abortsInFlight(lost, report.runs[claim.runId]))
            controller.abort(new Error('claim lost, or the run ended'));
        })
        .catch((err: unknown) => rt.report(err)),
    Math.max(10, Math.floor(rt.claimTtlMs / 3)),
  );
  let outcome: ChunkOutcome;
  try {
    const run = await rt.store.getRun(claim.runId);
    outcome = await inScope(rt.around, { runId: run.id, tenantId: run.tenantId, jobKey: run.jobKey }, () =>
      processChunk(
      {
        store: rt.store,
        registry: rt.registry,
        clock: rt.clock,
        events: rt.events,
        signal: controller.signal,
        limiters: rt.limiters,
        stops: rt.stops,
      },
      claim,
    ),
    );
  } finally {
    clearInterval(beat);
    release();
  }
  // A shutdown without drain gives back only this worker's own claim.
  if (outcome === 'aborted' && rt.stoppingWithoutDrain())
    await rt.store
      .releaseChunk(claim, { kind: 'yield' })
      .catch((err: unknown) => {
        if (!(err instanceof ClaimLostError)) throw err;
      });
  await rt.enqueueAdvance(data.runId, carried);
  return outcome;
}
