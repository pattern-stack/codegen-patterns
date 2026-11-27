/**
 * Unit tests for the JOB-6 jobs-scaffold locals resolver.
 *
 * Covers:
 *   - default locals on first install (no `jobs:` block in config)
 *   - workerExists: '' when src/worker.ts absent, 'true' when present
 *   - `staleWorkerNotice` names the one-time edit for a worker that predates
 *     JOBS-3 (it booted ADR-022's JobWorkerModule)
 *   - localsToHygenArgs serialises booleans safely (skip_if contract)
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
	localsToHygenArgs,
	resolveJobsScaffoldLocals,
	staleWorkerNotice,
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
			readFile: () => null,
		});

		expect(locals.workerExists).toBe(false);
		expect(locals.appName).toBe('project-fixture');
		expect(locals.mainTsPath).toBe(path.resolve(CWD, 'src/main.ts'));
		expect(locals.configPath).toBe(path.resolve(CWD, 'codegen.config.yaml'));
		// #513: worker now lands at src/worker.ts (inside the default tsconfig
		// include, next to app.module.ts).
		expect(locals.workerPath).toBe(path.resolve(CWD, 'src', 'worker.ts'));
		// Default derives from `backend_src` (fallback 'src') when
		// The subsystems root derives from `paths.backend_src` — the `project init` layout.
		expect(locals.schemaPath).toBe(
			path.resolve(CWD, 'src/shared/subsystems/jobs/job-orchestration.schema.ts'),
		);
	});

	test('the subsystems root derives from paths.backend_src (<backend_src>/shared/subsystems)', () => {
		const locals = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: { paths: { backend_src: 'packages/api/src' } } as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(locals.schemaPath).toBe(
			path.resolve(
				CWD,
				'packages/api/src/shared/subsystems/jobs/job-orchestration.schema.ts',
			),
		);
	});





	test('workerExists only probes src/worker.ts', () => {
		const probed: string[] = [];
		const locals = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: (p) => {
				probed.push(p);
				return p.endsWith('worker.ts');
			},
			readFile: () => null,
		});
		expect(probed).toEqual([path.resolve(CWD, 'src', 'worker.ts')]);
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
				readFile: () => null,
			}),
		).not.toThrow();
	});

	test('mainHookInjected: true when main.ts already contains the sentinel', () => {
		const locals = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
			readFile: () => '  // JOBS — the job executor (@pattern-stack/jobs, JOBS-3)\n',
		});
		expect(locals.mainHookInjected).toBe(true);
	});

	test('mainHookInjected: false when main.ts missing or lacks sentinel', () => {
		const missing = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(missing.mainHookInjected).toBe(false);

		const present = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
			readFile: () => 'async function bootstrap() {}',
		});
		expect(present.mainHookInjected).toBe(false);
	});

	test('skipSchema: true in package mode (default), false in vendored — #517', () => {
		// No `runtime` key → package mode (ADR-037). The schema ships in the
		// package (consumed via the schema barrel), so the template is skipped.
		const pkg = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(pkg.skipSchema).toBe(true);

		// Vendored mode keeps the template as the sole tenancy-aware emitter.
		const vendored = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: { runtime: 'vendored' } as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(vendored.skipSchema).toBe(false);
	});
});

describe('localsToHygenArgs', () => {
	const base: JobsScaffoldLocals = {
		appName: 'demo',
		mainTsPath: '/abs/src/main.ts',
		configPath: '/abs/codegen.config.yaml',
		workerExists: false,
		workerPath: '/abs/src/worker.ts',
		schemaPath: '/abs/shared/subsystems/jobs/job-orchestration.schema.ts',
		mainHookInjected: false,
		skipSchema: false,
	};


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
			'--mainTsPath',
			'--configPath',
			'--workerExists',
			'--workerPath',
			'--schemaPath',
			'--mainHookInjected',
			'--skipSchema',
		]) {
			expect(args).toContain(flag);
		}
	});

	test('skipSchema serialises empty-string when false, "true" when set — skip_if safe (#517)', () => {
		// Same boolean-ish contract as workerExists / mainHookInjected: Hygen's
		// skip_if treats any non-empty string as truthy, so a `false` must reach
		// the template as '' (not the truthy literal 'false').
		const args = localsToHygenArgs(base);
		const idx = args.indexOf('--skipSchema');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe('');

		const present = localsToHygenArgs({ ...base, skipSchema: true });
		const idx2 = present.indexOf('--skipSchema');
		expect(present[idx2 + 1]).toBe('true');
	});


	test('localsToHygenArgs serialises mainHookInjected empty-string when false', () => {
		const args = localsToHygenArgs(base);
		const idx = args.indexOf('--mainHookInjected');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe('');

		const present = localsToHygenArgs({ ...base, mainHookInjected: true });
		const idx2 = present.indexOf('--mainHookInjected');
		expect(present[idx2 + 1]).toBe('true');
	});

	test('paths pass through as absolute', () => {
		const args = localsToHygenArgs(base);
		expect(args).toContain('/abs/src/worker.ts');
		expect(args).toContain('/abs/src/main.ts');
		expect(args).toContain('/abs/codegen.config.yaml');
		expect(args).toContain('/abs/shared/subsystems/jobs/job-orchestration.schema.ts');
	});
});

describe('staleWorkerNotice (JOBS-3)', () => {
	test('a current worker (it starts JOBS_EXECUTOR) needs no edit', () => {
		expect(
			staleWorkerNotice(
				"  await app.get<{ start(): Promise<void> }>(JOBS_EXECUTOR).start();",
				'src/worker.ts',
			),
		).toBeNull();
	});

	test('a pre-JOBS-3 worker (JobWorkerModule) gets the exact replacement', () => {
		const notice = staleWorkerNotice(
			"    JobWorkerModule.forRoot(jobWorkerOptions),",
			'apps/api/src/worker.ts',
		);
		expect(notice).toContain('apps/api/src/worker.ts predates JOBS-3');
		expect(notice).toContain("import { JOBS_EXECUTOR } from '@pattern-stack/jobs/nest';");
		expect(notice).toContain('await app.get(JOBS_EXECUTOR).start();');
	});
});
