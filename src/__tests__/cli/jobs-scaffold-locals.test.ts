/**
 * Unit tests for the JOB-6 jobs-scaffold locals resolver.
 *
 * Covers:
 *   - default locals on first install (no `jobs:` block in config)
 *   - multi_tenant: true honored
 *   - worker_mode: 'standalone' honored
 *   - custom `paths.subsystems` flows into schemaPath
 *   - workerExists: '' when src/worker.ts absent, 'true' when present
 *   - jobWorkerModuleImport is mode-aware (package vs vendored) — #513
 *   - workerForRootOpts mirrors the embedded composer's backend/extension
 *     clauses with mode:standalone first + allPools last — #513
 *   - localsToHygenArgs serialises booleans safely (skip_if contract)
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
	encodeWorkerForRootOpts,
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
		// #513: default (no `runtime` key) is package mode (ADR-037), and the
		// standalone forRoot defaults to the bare drizzle shape.
		expect(locals.jobWorkerModuleImport).toBe(
			'@pattern-stack/codegen/runtime/subsystems/jobs/index',
		);
		expect(locals.workerForRootOpts).toBe(
			"{ mode: 'standalone', allPools: true }",
		);
		// Default derives from `backend_src` (fallback 'src') when
		// `paths.subsystems` is unset — matches `project init` layout.
		expect(locals.schemaPath).toBe(
			path.resolve(CWD, 'src/shared/subsystems/jobs/job-orchestration.schema.ts'),
		);
	});

	test('paths.backend_src derives default subsystems root when paths.subsystems is unset', () => {
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

	test('paths.subsystems takes precedence over paths.backend_src', () => {
		const locals = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: {
				paths: {
					backend_src: 'packages/api/src',
					subsystems: 'custom/subsystems',
				},
			} as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(locals.schemaPath).toBe(
			path.resolve(CWD, 'custom/subsystems/jobs/job-orchestration.schema.ts'),
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

	test('workerForRootOpts: drizzle default → mode:standalone + allPools only', () => {
		const drizzleDefault = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(drizzleDefault.workerForRootOpts).toBe(
			"{ mode: 'standalone', allPools: true }",
		);
	});

	test('workerForRootOpts: drizzle listen_notify/poll_interval knobs flow into domainModuleExtensions', () => {
		const withKnobs = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: {
				jobs: {
					backend: 'drizzle',
					extensions: {
						drizzle: { listen_notify: true, poll_interval_ms: 500 },
					},
				},
			} as any,
			fileExists: () => false,
			readFile: () => null,
		});
		// mode first, allPools last, knobs mirrored as camelCase between them.
		expect(withKnobs.workerForRootOpts).toBe(
			"{ mode: 'standalone', domainModuleExtensions: { drizzle: { listenNotify: true, pollIntervalMs: 500 } }, allPools: true }",
		);
	});

	test('workerForRootOpts: bullmq backend threads backend + its extension block', () => {
		const bullmq = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: {
				jobs: {
					backend: 'bullmq',
					extensions: { bullmq: { redis_url: 'redis://localhost:6379' } },
				},
			} as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(bullmq.workerForRootOpts).toBe(
			"{ mode: 'standalone', backend: 'bullmq', domainModuleExtensions: { bullmq: { redis_url: 'redis://localhost:6379' } }, allPools: true }",
		);
	});

	test('custom paths.subsystems flows into schemaPath', () => {
		const locals = resolveJobsScaffoldLocals({
			cwd: CWD,
			config: { paths: { subsystems: 'packages/api/src/subsystems' } } as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(locals.schemaPath).toBe(
			path.resolve(
				CWD,
				'packages/api/src/subsystems/jobs/job-orchestration.schema.ts',
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
		workerForRootOpts: "{ mode: 'standalone', allPools: true }",
		schemaPath: '/abs/shared/subsystems/jobs/job-orchestration.schema.ts',
		mainHookInjected: false,
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
			'--workerForRootOpts',
			'--schemaPath',
			'--mainHookInjected',
		]) {
			expect(args).toContain(flag);
		}
	});

	test('jobWorkerModuleImport passes through verbatim; workerForRootOpts is base64-encoded', () => {
		const args = localsToHygenArgs(base);
		const importIdx = args.indexOf('--jobWorkerModuleImport');
		expect(importIdx).toBeGreaterThanOrEqual(0);
		expect(args[importIdx + 1]).toBe(
			'@pattern-stack/codegen/runtime/subsystems/jobs/index',
		);
		// #513: the TS-literal opts are base64-encoded across the hygen arg
		// boundary (yargs would otherwise shred the `{ … }` syntax). The encoded
		// value must round-trip back to the source string.
		const optsIdx = args.indexOf('--workerForRootOpts');
		expect(optsIdx).toBeGreaterThanOrEqual(0);
		const encoded = args[optsIdx + 1];
		expect(encoded).toBe(
			encodeWorkerForRootOpts("{ mode: 'standalone', allPools: true }"),
		);
		expect(Buffer.from(encoded, 'base64').toString('utf-8')).toBe(
			"{ mode: 'standalone', allPools: true }",
		);
		// The encoded form must NOT contain raw braces/colons that yargs mangles.
		expect(encoded).not.toContain('{');
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
