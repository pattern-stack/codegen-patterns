/**
 * Unit tests for the JOB-6 jobs-scaffold locals resolver.
 *
 * Covers:
 *   - default locals on first install (no `jobs:` block in config)
 *   - multi_tenant: true honored
 *   - worker_mode: 'standalone' honored
 *   - custom `paths.subsystems` flows into schemaPath
 *   - workerExists: '' when worker.ts absent, 'true' when present
 *   - localsToHygenArgs serialises booleans safely (skip_if contract)
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
	localsToHygenArgs,
	resolveJobsScaffoldLocals,
	type JobsScaffoldLocals,
} from '../../cli/shared/jobs-scaffold-locals.js';

const CWD = '/tmp/project-fixture';

function never(): never {
	throw new Error('fileExists probe should not be called');
}

describe('resolveJobsScaffoldLocals', () => {
	test('fresh-install defaults (no jobs block)', () => {
		const locals = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
		});

		expect(locals.multiTenant).toBe(false);
		expect(locals.workerMode).toBe('embedded');
		expect(locals.workerExists).toBe(false);
		expect(locals.appName).toBe('project-fixture');
		expect(locals.mainTsPath).toBe(path.resolve(CWD, 'src/main.ts'));
		expect(locals.configPath).toBe(path.resolve(CWD, 'codegen.config.yaml'));
		expect(locals.workerPath).toBe(path.resolve(CWD, 'worker.ts'));
		expect(locals.schemaPath).toBe(
			path.resolve(CWD, 'shared/subsystems/jobs/job-orchestration.schema.ts'),
		);
	});

	test('jobs.multi_tenant: true flows into multiTenant local', () => {
		const locals = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: { jobs: { multi_tenant: true } } as any,
			fileExists: () => false,
		});
		expect(locals.multiTenant).toBe(true);
	});

	test('jobs.multi_tenant non-boolean values do not leak through', () => {
		// only the literal `true` flips the flag — defensive against YAML truthy
		// surprises like `'yes'` / `1`.
		for (const raw of ['true', 'yes', 1, 'on']) {
			const locals = resolveJobsScaffoldLocals({
				cwd: CWD,
				config: { jobs: { multi_tenant: raw } } as any,
				fileExists: () => false,
			});
			expect(locals.multiTenant).toBe(false);
		}
	});

	test('jobs.worker_mode: standalone is honored; any other value defaults to embedded', () => {
		const standalone = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: { jobs: { worker_mode: 'standalone' } } as any,
			fileExists: () => false,
		});
		expect(standalone.workerMode).toBe('standalone');

		const bogus = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: { jobs: { worker_mode: 'wobbly' } } as any,
			fileExists: () => false,
		});
		expect(bogus.workerMode).toBe('embedded');
	});

	test('custom paths.subsystems flows into schemaPath', () => {
		const locals = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: { paths: { subsystems: 'packages/api/src/subsystems' } } as any,
			fileExists: () => false,
		});
		expect(locals.schemaPath).toBe(
			path.resolve(
				CWD,
				'packages/api/src/subsystems/jobs/job-orchestration.schema.ts',
			),
		);
	});

	test('workerExists only probes worker.ts at project root', () => {
		const probed: string[] = [];
		const locals = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: (p) => {
				probed.push(p);
				return p.endsWith('worker.ts');
			},
		});
		expect(probed).toEqual([path.resolve(CWD, 'worker.ts')]);
		expect(locals.workerExists).toBe(true);
	});

	test('fileExists is not called beyond worker probe', () => {
		expect(() =>
			resolveJobsScaffoldLocals({
				cwd: CWD,
				config: null,
				// Only worker.ts path is allowed — anything else throws via `never`.
				fileExists: (p) => {
					if (!p.endsWith('worker.ts')) never();
					return false;
				},
			}),
		).not.toThrow();
	});
});

describe('localsToHygenArgs', () => {
	const base: JobsScaffoldLocals = {
		appName: 'demo',
		workerMode: 'embedded',
		multiTenant: false,
		mainTsPath: '/abs/src/main.ts',
		configPath: '/abs/codegen.config.yaml',
		workerExists: false,
		workerPath: '/abs/worker.ts',
		schemaPath: '/abs/shared/subsystems/jobs/job-orchestration.schema.ts',
	};

	test('multiTenant booleans serialise to the literal strings Hygen expects', () => {
		expect(localsToHygenArgs(base)).toContain('false');
		expect(localsToHygenArgs({ ...base, multiTenant: true })).toContain('true');
	});

	test('workerExists serialises to empty string when absent — skip_if safe', () => {
		// Hygen's skip_if treats any non-empty string as truthy. Rendering a
		// boolean `false` would serialise to 'false' (truthy!). We assert the
		// empty-string invariant here to lock this in.
		const args = localsToHygenArgs(base);
		// --workerExists is followed by '' — find the flag index.
		const idx = args.indexOf('--workerExists');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe('');

		const present = localsToHygenArgs({ ...base, workerExists: true });
		const idx2 = present.indexOf('--workerExists');
		expect(present[idx2 + 1]).toBe('true');
	});

	test('all required flags present', () => {
		const args = localsToHygenArgs(base);
		for (const flag of [
			'--appName',
			'--workerMode',
			'--multiTenant',
			'--mainTsPath',
			'--configPath',
			'--workerExists',
			'--workerPath',
			'--schemaPath',
		]) {
			expect(args).toContain(flag);
		}
	});

	test('paths pass through as absolute', () => {
		const args = localsToHygenArgs(base);
		expect(args).toContain('/abs/worker.ts');
		expect(args).toContain('/abs/src/main.ts');
		expect(args).toContain('/abs/codegen.config.yaml');
		expect(args).toContain('/abs/shared/subsystems/jobs/job-orchestration.schema.ts');
	});
});
