/**
 * Unit tests for the JOB-6 jobs-scaffold locals resolver.
 *
 * Covers:
 *   - default locals on first install (no `jobs:` block in config)
 *   - multi_tenant: true honored
 *   - worker_mode: 'standalone' honored
 *   - workerExists: '' when src/worker.ts absent, 'true' when present
 *   - jobWorkerModuleImport is mode-aware (package vs vendored) — #513
 *   - the worker carries no config value: it imports `jobWorkerOptions` from
 *     `<generated>/app-config` (GEN-0, #652); `staleWorkerNotice` names the
 *     one-time edit for a pre-GEN-0 worker
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

		expect(locals.multiTenant).toBe(false);
		expect(locals.workerMode).toBe('embedded');
		expect(locals.workerExists).toBe(false);
		expect(locals.appName).toBe('project-fixture');
		expect(locals.mainTsPath).toBe(path.resolve(CWD, 'src/main.ts'));
		expect(locals.configPath).toBe(path.resolve(CWD, 'codegen.config.yaml'));
		// #513: worker now lands at src/worker.ts (inside the default tsconfig
		// include, next to app.module.ts).
		expect(locals.workerPath).toBe(path.resolve(CWD, 'src', 'worker.ts'));
		// #513: default (no `runtime` key) is package mode (ADR-037).
		expect(locals.jobWorkerModuleImport).toBe(
			'@pattern-stack/codegen/runtime/subsystems/jobs/index',
		);
		// GEN-0: the worker's options come from the generated app-config.
		expect(locals.appConfigImport).toBe('./generated/app-config');
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

	test('jobs.multi_tenant: true flows into multiTenant local', () => {
		const locals = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: { jobs: { multi_tenant: true } } as any,
			fileExists: () => false,
			readFile: () => null,
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
				readFile: () => null,
			});
			expect(locals.multiTenant).toBe(false);
		}
	});

	test('jobs.worker_mode: standalone is honored; any other value defaults to embedded', () => {
		const standalone = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: { jobs: { worker_mode: 'standalone' } } as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(standalone.workerMode).toBe('standalone');

		const bogus = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: { jobs: { worker_mode: 'wobbly' } } as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(bogus.workerMode).toBe('embedded');
	});

	test('jobWorkerModuleImport: package mode (default) resolves the package runtime subpath', () => {
		// No `runtime` key → package mode (ADR-037). The JobWorkerModule is NOT on
		// the top-level `/subsystems` barrel; it resolves via the per-subsystem
		// runtime index.
		const pkg = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(pkg.jobWorkerModuleImport).toBe(
			'@pattern-stack/codegen/runtime/subsystems/jobs/index',
		);
	});

	test('jobWorkerModuleImport: vendored mode resolves the @shared jobs barrel', () => {
		const vendored = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: { runtime: 'vendored' } as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(vendored.jobWorkerModuleImport).toBe(
			'@shared/subsystems/jobs/index',
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
			readFile: () => '// JOBS — Embedded worker mode (optional)\n',
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
		workerMode: 'embedded',
		multiTenant: false,
		mainTsPath: '/abs/src/main.ts',
		configPath: '/abs/codegen.config.yaml',
		workerExists: false,
		workerPath: '/abs/src/worker.ts',
		jobWorkerModuleImport:
			'@pattern-stack/codegen/runtime/subsystems/jobs/index',
		appConfigImport: './generated/app-config',
		schemaPath: '/abs/shared/subsystems/jobs/job-orchestration.schema.ts',
		mainHookInjected: false,
		skipSchema: false,
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
			'--jobWorkerModuleImport',
			'--appConfigImport',
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

	test('jobWorkerModuleImport and appConfigImport pass through verbatim; no options literal crosses argv (GEN-0)', () => {
		const args = localsToHygenArgs(base);
		expect(args[args.indexOf('--jobWorkerModuleImport') + 1]).toBe(
			'@pattern-stack/codegen/runtime/subsystems/jobs/index',
		);
		expect(args[args.indexOf('--appConfigImport') + 1]).toBe('./generated/app-config');
		expect(args).not.toContain('--workerForRootOpts');
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

describe('staleWorkerNotice (GEN-0, #652)', () => {
	test('a current worker needs no edit', () => {
		expect(
			staleWorkerNotice(
				"import { jobWorkerOptions } from './generated/app-config';\n    JobWorkerModule.forRoot(jobWorkerOptions),",
				'src/worker.ts',
				'./generated/app-config',
			),
		).toBeNull();
	});

	test('a worker that bakes its options gets the exact replacement', () => {
		const notice = staleWorkerNotice(
			"    JobWorkerModule.forRoot({ mode: 'standalone', domainModulePools: jobPools, allPools: true }),",
			'apps/api/src/worker.ts',
			'./generated/app-config',
		);
		expect(notice).toContain('apps/api/src/worker.ts predates GEN-0 (#652)');
		expect(notice).toContain("import { jobWorkerOptions } from './generated/app-config';");
		expect(notice).toContain('JobWorkerModule.forRoot(jobWorkerOptions),');
	});
});
