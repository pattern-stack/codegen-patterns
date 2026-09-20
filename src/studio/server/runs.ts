/**
 * The run registry and its SSE stream (STUDIO-0, #698).
 *
 * One run at a time, per server. A second `POST /api/generate` while a run is
 * in flight is a 409 with the id of the run already going — not a queue, and
 * not two generators writing the same files at once.
 *
 * Events are buffered as well as broadcast. A client necessarily subscribes
 * AFTER the POST that started the run, so without replay the first log lines —
 * and, on a fast run, the terminal `done` — would be lost to the race. A
 * subscriber receives everything emitted so far, then everything after.
 */

import type {
	DiffResponse,
	RunEvent,
	RunStepName,
	RunStepStatus,
} from '../shared/api.js';
import { streamCli, streamCommand } from './cli-runner.js';
import { getDiff } from './diff.js';
import { hasRelationshipYamls } from './graph.js';
import { drizzlePushPlan } from '../../cli/commands/dev.js';

export type RunListener = (event: RunEvent) => void;

export interface Run {
	id: string;
	steps: RunStepName[];
	/** Every event emitted so far, replayed to a late subscriber. */
	events: RunEvent[];
	listeners: Set<RunListener>;
	done: boolean;
	ok: boolean;
}

export class RunConflictError extends Error {
	readonly runId: string;
	constructor(runId: string) {
		super(`A run is already in progress (${runId})`);
		this.name = 'RunConflictError';
		this.runId = runId;
	}
}

const VALID_STEPS: RunStepName[] = ['generate', 'dbPush', 'restart'];

export function parseSteps(body: unknown): RunStepName[] {
	const steps = (body as { steps?: unknown } | null)?.steps;
	if (!Array.isArray(steps) || steps.length === 0) {
		throw new Error('`steps` must be a non-empty array');
	}
	for (const s of steps) {
		if (typeof s !== 'string' || !VALID_STEPS.includes(s as RunStepName)) {
			throw new Error(`unknown step '${String(s)}' — expected one of ${VALID_STEPS.join(', ')}`);
		}
	}
	return steps as RunStepName[];
}

export class RunRegistry {
	private readonly runs = new Map<string, Run>();
	private activeId: string | null = null;
	private counter = 0;

	/** The run currently in flight, or null. */
	active(): Run | null {
		return this.activeId ? (this.runs.get(this.activeId) ?? null) : null;
	}

	get(id: string): Run | undefined {
		return this.runs.get(id);
	}

	/**
	 * Register a new run. Throws {@link RunConflictError} when one is already
	 * in flight — the caller turns that into a 409.
	 */
	begin(steps: RunStepName[]): Run {
		const current = this.active();
		if (current && !current.done) throw new RunConflictError(current.id);

		this.counter += 1;
		const id = `run-${Date.now().toString(36)}-${this.counter}`;
		const run: Run = { id, steps, events: [], listeners: new Set(), done: false, ok: false };
		this.runs.set(id, run);
		this.activeId = id;
		return run;
	}

	emit(run: Run, event: RunEvent): void {
		run.events.push(event);
		for (const listener of run.listeners) listener(event);
	}

	finish(run: Run, ok: boolean, diff: DiffResponse): void {
		run.ok = ok;
		run.done = true;
		this.emit(run, { type: 'done', ok, diff });
		if (this.activeId === run.id) this.activeId = null;
		run.listeners.clear();
	}

	/**
	 * Subscribe to a run: replay what it has already emitted, then receive the
	 * rest. Returns an unsubscribe function.
	 */
	subscribe(run: Run, listener: RunListener): () => void {
		for (const event of run.events) listener(event);
		if (run.done) return () => {};
		run.listeners.add(listener);
		return () => run.listeners.delete(listener);
	}
}

export interface ExecuteRunOptions {
	projectDir: string;
	registry: RunRegistry;
	run: Run;
}

/**
 * Run the requested steps in order, streaming output as it arrives.
 *
 * A failed step stops the run: the steps after it are reported `skipped`
 * rather than silently omitted, so the UI's step list matches what was asked
 * for.
 */
export async function executeRun(opts: ExecuteRunOptions): Promise<void> {
	const { projectDir, registry, run } = opts;
	const log = (line: string) => registry.emit(run, { type: 'log', line });
	const step = (name: RunStepName, status: RunStepStatus) =>
		registry.emit(run, { type: 'step', name, status });

	let ok = true;

	for (const name of run.steps) {
		if (!ok) {
			step(name, 'skipped');
			continue;
		}
		step(name, 'running');
		const result = await runStep(name, projectDir, log);
		if (result === 'skipped') {
			step(name, 'skipped');
			continue;
		}
		if (!result) ok = false;
		step(name, result ? 'ok' : 'failed');
	}

	registry.finish(run, ok, getDiff(projectDir));
}

/** true = succeeded, false = failed, 'skipped' = nothing to do. */
async function runStep(
	name: RunStepName,
	projectDir: string,
	log: (line: string) => void,
): Promise<boolean | 'skipped'> {
	switch (name) {
		case 'generate': {
			// `--force` is required, not optional: the demo project is git-backed,
			// so after the first run the generated tree is dirty and the CLI's
			// uncommitted-changes guard would refuse every subsequent Generate.
			log('$ codegen entity new --all --force');
			const entities = await streamCli(
				['entity', 'new', '--all', '--force'],
				{ cwd: projectDir },
				log,
			);
			if (entities.error) {
				log(entities.error);
				return false;
			}
			if (entities.exitCode !== 0) return false;

			if (!hasRelationshipYamls(projectDir)) return true;
			log('$ codegen relationship new --all --force');
			const rels = await streamCli(
				['relationship', 'new', '--all', '--force'],
				{ cwd: projectDir },
				log,
			);
			if (rels.error) {
				log(rels.error);
				return false;
			}
			return rels.exitCode === 0;
		}

		case 'dbPush': {
			// The project's OWN drizzle-kit, via the same plan `codegen dev up`
			// uses — never a bare `bunx` that would fetch @latest into a shared
			// cache and pair a kit with an ORM line it was not built for (#688).
			const plan = drizzlePushPlan(projectDir);
			if (!plan) {
				log('no drizzle.config.ts in this project — nothing to push');
				return 'skipped';
			}
			log(`$ ${plan.command}`);
			const [command, ...args] = plan.command.split(/\s+/);
			const push = await streamCommand(command, args, { cwd: projectDir }, log);
			if (push.error) {
				log(push.error);
				return false;
			}
			return push.exitCode === 0;
		}

		case 'restart': {
			log('$ codegen dev restart');
			const restart = await streamCli(['dev', 'restart'], { cwd: projectDir }, log);
			if (restart.error) {
				log(restart.error);
				return false;
			}
			return restart.exitCode === 0;
		}
	}
}
