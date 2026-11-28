/**
 * `subsystem install jobs` under `wiring: pattern-stack` (review #984): the `jobs` system starts the executor, so the
 * scaffold plans no worker.ts and no main.ts hook, and its success line names only what it planned.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { jobsScaffoldSummary, runJobsScaffold } from '../../cli/commands/subsystem';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-install-ps-'));
	dirs.push(cwd);
	fs.writeFileSync(
		path.join(cwd, 'codegen.config.yaml'),
		'target:\n  database: postgres\n  orm: drizzle\n  wiring: pattern-stack\n  http: none\n',
	);
	return cwd;
}

const PATTERN_STACK = { target: { database: 'postgres', orm: 'drizzle', wiring: 'pattern-stack', http: 'none' } } as never;

describe('the jobs scaffold under pattern-stack', () => {
	it('plans no worker.ts and no main.ts hook, and writes neither', () => {
		const cwd = project();
		const outcome = runJobsScaffold(cwd, PATTERN_STACK, { dryRun: true, json: true, forceConfig: false });
		expect(outcome.ok).toBe(true);
		expect(outcome.planned.map((p) => path.relative(cwd, p))).toEqual(['codegen.config.yaml']);
		expect(outcome.planned.some((p) => /worker\.ts$|main\.ts$/.test(p))).toBe(false);
		expect(fs.existsSync(path.join(cwd, 'src/worker.ts'))).toBe(false);
	});

	it('its success line names only what it planned', () => {
		const cwd = project();
		expect(jobsScaffoldSummary(cwd, [path.join(cwd, 'codegen.config.yaml')])).toBe('jobs scaffold applied (codegen.config.yaml)');
		expect(jobsScaffoldSummary(cwd, [])).not.toMatch(/worker|main\.ts/);
	});
});
