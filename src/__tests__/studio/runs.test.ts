/**
 * The run registry (STUDIO-0, #698).
 *
 * Two properties the UI depends on:
 *   - a second Generate while one is running is a 409, not a second generator
 *     writing the same files;
 *   - a subscriber that attaches AFTER the run started still sees everything.
 *     A client necessarily subscribes after the POST that started the run, so
 *     without replay a fast run's terminal `done` would be lost to the race and
 *     the UI would hang on a spinner forever.
 */
import { describe, it, expect } from 'bun:test';

import { RunConflictError, RunRegistry, parseSteps } from '../../studio/server/runs';
import type { RunEvent } from '../../studio/shared/api';

describe('parseSteps', () => {
	it('accepts the three known steps', () => {
		expect(parseSteps({ steps: ['generate', 'dbPush', 'restart'] })).toEqual([
			'generate',
			'dbPush',
			'restart',
		]);
	});

	it('rejects an empty list', () => {
		expect(() => parseSteps({ steps: [] })).toThrow('`steps`');
	});

	it('rejects a missing list', () => {
		expect(() => parseSteps({})).toThrow('`steps`');
	});

	it('rejects a non-array', () => {
		expect(() => parseSteps({ steps: 'generate' })).toThrow('`steps`');
	});

	it('rejects an unknown step by name', () => {
		expect(() => parseSteps({ steps: ['generate', 'deploy'] })).toThrow("unknown step 'deploy'");
	});
});

describe('RunRegistry — one run at a time', () => {
	it('begins a run and reports it active', () => {
		const registry = new RunRegistry();
		const run = registry.begin(['generate']);
		expect(registry.active()?.id).toBe(run.id);
		expect(registry.get(run.id)).toBe(run);
	});

	it('gives each run a distinct id', () => {
		const registry = new RunRegistry();
		const a = registry.begin(['generate']);
		registry.finish(a, true, { files: [] });
		const b = registry.begin(['generate']);
		expect(b.id).not.toBe(a.id);
	});

	it('REFUSES a second run while one is in flight, naming the run in the way', () => {
		const registry = new RunRegistry();
		const first = registry.begin(['generate']);
		expect(() => registry.begin(['generate'])).toThrow(RunConflictError);
		try {
			registry.begin(['generate']);
		} catch (err) {
			expect((err as RunConflictError).runId).toBe(first.id);
		}
	});

	it('accepts a new run once the first has finished', () => {
		const registry = new RunRegistry();
		const first = registry.begin(['generate']);
		registry.finish(first, true, { files: [] });
		expect(registry.active()).toBeNull();
		expect(() => registry.begin(['generate'])).not.toThrow();
	});

	it('clears the active slot even when the run failed', () => {
		const registry = new RunRegistry();
		const first = registry.begin(['generate']);
		registry.finish(first, false, { files: [] });
		expect(registry.active()).toBeNull();
	});
});

describe('RunRegistry — subscription', () => {
	it('delivers events emitted after subscribing', () => {
		const registry = new RunRegistry();
		const run = registry.begin(['generate']);
		const seen: RunEvent[] = [];
		registry.subscribe(run, (e) => seen.push(e));
		registry.emit(run, { type: 'log', line: 'hello' });
		expect(seen).toEqual([{ type: 'log', line: 'hello' }]);
	});

	it('REPLAYS events emitted before the subscriber attached', () => {
		const registry = new RunRegistry();
		const run = registry.begin(['generate']);
		registry.emit(run, { type: 'step', name: 'generate', status: 'running' });
		registry.emit(run, { type: 'log', line: 'early line' });

		const seen: RunEvent[] = [];
		registry.subscribe(run, (e) => seen.push(e));
		expect(seen).toEqual([
			{ type: 'step', name: 'generate', status: 'running' },
			{ type: 'log', line: 'early line' },
		]);
	});

	it('replays the terminal `done` to a subscriber that arrived too late', () => {
		const registry = new RunRegistry();
		const run = registry.begin(['generate']);
		registry.emit(run, { type: 'log', line: 'fast' });
		registry.finish(run, true, { files: [] });

		const seen: RunEvent[] = [];
		registry.subscribe(run, (e) => seen.push(e));
		expect(seen.at(-1)).toEqual({ type: 'done', ok: true, diff: { files: [] } });
	});

	it('fans one event out to every subscriber', () => {
		const registry = new RunRegistry();
		const run = registry.begin(['generate']);
		const a: RunEvent[] = [];
		const b: RunEvent[] = [];
		registry.subscribe(run, (e) => a.push(e));
		registry.subscribe(run, (e) => b.push(e));
		registry.emit(run, { type: 'log', line: 'x' });
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
	});

	it('stops delivering after unsubscribe', () => {
		const registry = new RunRegistry();
		const run = registry.begin(['generate']);
		const seen: RunEvent[] = [];
		const off = registry.subscribe(run, (e) => seen.push(e));
		off();
		registry.emit(run, { type: 'log', line: 'ignored' });
		expect(seen).toHaveLength(0);
	});

	it('marks the run done and records its outcome', () => {
		const registry = new RunRegistry();
		const run = registry.begin(['generate', 'dbPush']);
		registry.finish(run, false, { files: [{ path: 'a.ts', status: 'modified', patch: '' }] });
		expect(run.done).toBe(true);
		expect(run.ok).toBe(false);
		const done = run.events.at(-1);
		expect(done?.type).toBe('done');
	});
});
