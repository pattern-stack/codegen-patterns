/**
 * Run state — what the drawer shows while a generate run streams.
 *
 * Kept out of the component so the reducer is a plain function of
 * (state, RunEvent), which is the part worth reasoning about.
 */
import type { DiffResponse, RunEvent, RunStepName, RunStepStatus } from '@studio-shared';

/** The steps the UI offers, in the order the server runs them. */
export const RUN_STEPS: readonly { name: RunStepName; label: string; hint: string }[] = [
  { name: 'generate', label: 'Generate', hint: 'Run the generator over every entity' },
  { name: 'dbPush', label: 'DB push', hint: 'Push the Drizzle schema to the database' },
  { name: 'restart', label: 'Restart', hint: 'Restart the demo app so it picks up the new code' },
];

export interface LogLine {
  /** Monotonic, so React keys stay stable as lines arrive. */
  seq: number;
  text: string;
}

export interface RunState {
  runId: string | null;
  /** `idle` before the first run; `done` once a `done` event arrived. */
  phase: 'idle' | 'starting' | 'running' | 'done' | 'error';
  steps: Partial<Record<RunStepName, RunStepStatus>>;
  log: LogLine[];
  diff: DiffResponse | null;
  ok: boolean | null;
  /** Transport or server error — not a failed step, which lives in `steps`. */
  error: string | null;
}

export const initialRunState: RunState = {
  runId: null,
  phase: 'idle',
  steps: {},
  log: [],
  diff: null,
  ok: null,
  error: null,
};

/** The log is capped so a long generate cannot grow the DOM without bound. */
const MAX_LOG_LINES = 4000;

export type RunAction =
  | { type: 'start' }
  | { type: 'started'; runId: string }
  | { type: 'event'; event: RunEvent }
  | { type: 'failed'; message: string }
  | { type: 'clear' };

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'start':
      return { ...initialRunState, phase: 'starting' };

    case 'started':
      return { ...state, phase: 'running', runId: action.runId };

    case 'event': {
      const { event } = action;
      if (event.type === 'log') {
        const seq = (state.log[state.log.length - 1]?.seq ?? -1) + 1;
        const log = [...state.log, { seq, text: event.line }];
        return { ...state, log: log.length > MAX_LOG_LINES ? log.slice(-MAX_LOG_LINES) : log };
      }
      if (event.type === 'step') {
        return { ...state, steps: { ...state.steps, [event.name]: event.status } };
      }
      return { ...state, phase: 'done', ok: event.ok, diff: event.diff };
    }

    case 'failed':
      return { ...state, phase: 'error', error: action.message, ok: false };

    case 'clear':
      return initialRunState;
  }
}

/** True while a run holds the server's registry — the Generate button is off. */
export function isRunInFlight(state: RunState): boolean {
  return state.phase === 'starting' || state.phase === 'running';
}
