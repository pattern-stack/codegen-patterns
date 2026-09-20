/**
 * The run reducer — what the drawer shows as a generate streams.
 */
import { describe, expect, test } from 'bun:test';
import type { DiffResponse, RunEvent } from '@studio-shared';
import { initialRunState, isRunInFlight, runReducer } from '../drawer/run-state';
import type { RunState } from '../drawer/run-state';

const DIFF: DiffResponse = { files: [{ path: 'a.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x\n' }] };

function apply(events: RunEvent[], from: RunState = initialRunState): RunState {
  return events.reduce((state, event) => runReducer(state, { type: 'event', event }), from);
}

describe('runReducer', () => {
  test('a start clears the previous run', () => {
    const previous = apply([{ type: 'log', line: 'old' }]);
    const state = runReducer(previous, { type: 'start' });
    expect(state.log).toEqual([]);
    expect(state.diff).toBeNull();
    expect(state.phase).toBe('starting');
  });

  test('log lines accumulate with stable, increasing keys', () => {
    const state = apply([
      { type: 'log', line: 'one' },
      { type: 'log', line: 'two' },
    ]);
    expect(state.log.map((l) => l.text)).toEqual(['one', 'two']);
    expect(state.log.map((l) => l.seq)).toEqual([0, 1]);
  });

  test('step statuses overwrite per step, not per event', () => {
    const state = apply([
      { type: 'step', name: 'generate', status: 'running' },
      { type: 'step', name: 'dbPush', status: 'skipped' },
      { type: 'step', name: 'generate', status: 'ok' },
    ]);
    expect(state.steps).toEqual({ generate: 'ok', dbPush: 'skipped' });
  });

  test('done carries the diff and the outcome', () => {
    const state = apply([{ type: 'done', ok: true, diff: DIFF }]);
    expect(state.phase).toBe('done');
    expect(state.ok).toBe(true);
    expect(state.diff).toEqual(DIFF);
  });

  test('a failed run is done, not errored — the steps say what broke', () => {
    const state = apply([
      { type: 'step', name: 'generate', status: 'failed' },
      { type: 'done', ok: false, diff: { files: [] } },
    ]);
    expect(state.phase).toBe('done');
    expect(state.ok).toBe(false);
    expect(state.steps.generate).toBe('failed');
  });

  test('a transport failure is an error phase with a message', () => {
    const state = runReducer(initialRunState, { type: 'failed', message: 'stream died' });
    expect(state.phase).toBe('error');
    expect(state.error).toBe('stream died');
    expect(state.ok).toBe(false);
  });

  test('clear returns to the initial state', () => {
    const state = runReducer(apply([{ type: 'log', line: 'x' }]), { type: 'clear' });
    expect(state).toEqual(initialRunState);
  });

  test('the log is capped so a long run cannot grow without bound', () => {
    let state = initialRunState;
    for (let i = 0; i < 4200; i++) {
      state = runReducer(state, { type: 'event', event: { type: 'log', line: `line ${i}` } });
    }
    expect(state.log.length).toBe(4000);
    // The newest lines survive; the oldest are dropped.
    expect(state.log[state.log.length - 1]!.text).toBe('line 4199');
    // Keys stay strictly increasing across the drop.
    expect(state.log[1]!.seq).toBeGreaterThan(state.log[0]!.seq);
  });
});

describe('isRunInFlight', () => {
  test('true while starting and running, false once settled', () => {
    expect(isRunInFlight(initialRunState)).toBe(false);
    expect(isRunInFlight(runReducer(initialRunState, { type: 'start' }))).toBe(true);
    expect(
      isRunInFlight(runReducer(runReducer(initialRunState, { type: 'start' }), { type: 'started', runId: 'r1' })),
    ).toBe(true);
    expect(isRunInFlight(apply([{ type: 'done', ok: true, diff: DIFF }]))).toBe(false);
    expect(isRunInFlight(runReducer(initialRunState, { type: 'failed', message: 'x' }))).toBe(false);
  });
});
