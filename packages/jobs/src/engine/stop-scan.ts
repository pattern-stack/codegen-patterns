import type { ErasedMapStep } from '../define/step.ts';
import type { Run } from '../model/run.ts';
import type { ItemOutcome } from '../policy/stop.ts';
import type { JobStore } from '../ports/job-store.ts';
import { outcomesOf, settledRun } from './context.ts';

/**
 * A read of a step's growing prefix takes this many items past what the scan holds, doubling while all it read was
 * settled (up to `STOP_READ_MAX`): a read whose head is still unsettled costs this many rows, and one that finds a run
 * of settled items costs at most about twice that run.
 */
export const STOP_READ_FIRST = 8;
export const STOP_READ_MAX = 256;

/** A step's settled prefix as far as one process has read it: settled items never change, so it only grows. */
interface Scan {
  /** The ordinal of the first item not yet read into `before`. */
  next: number;
  /** The outcomes read so far, in order: what the predicate sees as `before`. */
  before: ItemOutcome<unknown>[];
  /** The stop, once found. */
  used: number | null;
  /** Reads of one scan run one at a time, so two never append the same items. */
  tail: Promise<unknown>;
}

/** Scans kept per process (an executor's); the oldest are dropped first, and a dropped scan starts again from 0. */
const MAX_SCANS = 256;

/**
 * Each map step's early-stop scan, kept by one executor so a read of the stop costs only what settled since the last
 * one (plus one window), never the whole step: the stop used to re-read every item and result on every settle.
 */
export class StopScans {
  private readonly scans = new Map<string, Scan>();

  /** The scan of a run's step, made fresh the first time. */
  get(runId: string, step: string): Scan {
    const key = `${runId}\u0000${step}`;
    let scan = this.scans.get(key);
    if (scan) {
      // Most recently used last, so the first entry is the one to drop.
      this.scans.delete(key);
    } else {
      scan = { next: 0, before: [], used: null, tail: Promise.resolve() };
      if (this.scans.size >= MAX_SCANS) {
        const oldest = this.scans.keys().next().value;
        if (oldest !== undefined) this.scans.delete(oldest);
      }
    }
    this.scans.set(key, scan);
    return scan;
  }

  /** A step that completed needs its scan no more. */
  drop(runId: string, step: string): void {
    this.scans.delete(`${runId}\u0000${step}`);
  }
}

/**
 * Where a map step's early stop falls (the items the result keeps), or null while the settled prefix holds none:
 * read over the contiguous settled prefix in order, exactly as `firstStop`, but from where `scans` last left off, a
 * window at a time. Without `scans` it reads from the first item.
 */
export async function readStop(
  store: JobStore,
  run: Run,
  name: string,
  erased: ErasedMapStep,
  scans?: StopScans,
): Promise<number | null> {
  const { stopWhen } = erased;
  if (!stopWhen) return null;
  const scan = scans?.get(run.id, name) ?? {
    next: 0,
    before: [],
    used: null,
    tail: Promise.resolve(),
  };
  const read = async (): Promise<number | null> => {
    let window = STOP_READ_FIRST;
    while (scan.used === null) {
      const page = await store.items(run.id, name, {
        from: scan.next,
        limit: window,
      });
      const settled = settledRun(page);
      for (const outcome of await outcomesOf(
        store,
        run,
        name,
        erased,
        settled,
      )) {
        if (stopWhen(outcome, scan.next, scan.before)) {
          scan.used = scan.next + 1;
          break;
        }
        scan.before.push(outcome);
        scan.next++;
      }
      // An unsettled item, or the end of what is planned: the prefix ends here for now.
      if (settled.length < page.length || page.length < window) break;
      window = Math.min(window * 2, STOP_READ_MAX);
    }
    return scan.used;
  };
  const result = scan.tail.then(read, read);
  // The next read waits on this one however it ended (`then(read, read)`); its rejection is the caller's to handle.
  scan.tail = result;
  return result;
}
