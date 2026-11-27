import type { PauseReason } from './run.ts';
import type { Counts, Speculation, WaitKind } from './step-state.ts';

/**
 * The fixed list of events a run emits. Every event carries ids and counts, never content: no item text, no
 * prompts, no inputs or outputs, and an error only by its type.
 */
interface Base {
  runId: string;
  jobKey: string;
  jobVersion: string;
  tenantId: string;
  at: Date;
}

interface StepBase extends Base {
  step: string;
  attempt: number;
}

export type RunEvent =
  | (Base & { type: 'run.started' })
  | (Base & { type: 'run.paused'; reason: PauseReason })
  | (Base & { type: 'run.resumed' })
  | (Base & { type: 'run.completed' })
  | (Base & { type: 'run.failed'; errorType: string })
  | (Base & { type: 'run.canceled' });

export type StepEvent =
  | (StepBase & { type: 'step.started' })
  /** Done over total moved; throttled. */
  | (StepBase & { type: 'step.progress'; counts: Counts })
  | (StepBase & {
      type: 'step.completed';
      counts: Counts;
      speculation: Speculation | null;
    })
  | (StepBase & { type: 'step.failed'; errorType: string })
  /** A map step with no items. */
  | (StepBase & { type: 'step.skipped' })
  /** A step, or one chunk of a map step (`chunk`), retried after a transient failure. */
  | (StepBase & {
      type: 'step.retried';
      errorType: string;
      chunk: number | null;
    })
  /** A step parked: on what (by kind and name, never content), and when it looks again. */
  | (StepBase & {
      type: 'step.waiting';
      waitKind: WaitKind;
      waitName: string;
      wakeAt: Date | null;
    })
  /** A parked step's wait settled, and it carries on. */
  | (StepBase & { type: 'step.woke'; waitKind: WaitKind; waitName: string })
  /** A signal settled the step's wait (`waitName`, the signal); by a timeout's value when `byTimeout`. Never the value. */
  | (StepBase & {
      type: 'step.signaled';
      waitKind: 'signal';
      waitName: string;
      byTimeout: boolean;
    });

/** One item failed for good; successes are counted, not each announced. */
export type ItemEvent = StepBase & {
  type: 'item.failed';
  key: string;
  errorType: string;
};

/** A children step's child: started in its slot, and ended (its error type when it failed or was canceled). */
export type ChildEvent =
  | (StepBase & { type: 'child.started'; childKey: string; childRunId: string })
  | (StepBase & {
      type: 'child.ended';
      childKey: string;
      childRunId: string;
      errorType: string | null;
    });

export type JobEvent = RunEvent | StepEvent | ItemEvent | ChildEvent;
export type JobEventType = JobEvent['type'];

export const JOB_EVENT_TYPES: readonly JobEventType[] = [
  'run.started',
  'run.paused',
  'run.resumed',
  'run.completed',
  'run.failed',
  'run.canceled',
  'step.started',
  'step.progress',
  'step.completed',
  'step.failed',
  'step.skipped',
  'step.retried',
  'step.waiting',
  'step.woke',
  'step.signaled',
  'child.started',
  'child.ended',
  'item.failed',
];
