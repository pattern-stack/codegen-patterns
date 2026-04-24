/**
 * Unit tests for the OBS-7 observability-scaffold locals resolver.
 *
 * Observability is a combiner subsystem (ADR-025): no schema, no worker, no
 * generated/ dir. The resolver steers only two templates — the `observability:`
 * config block and a `main-hook.ejs.t` TODO comment appended to app.module.ts.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
	localsToHygenArgs,
	resolveObservabilityScaffoldLocals,
	type ObservabilityScaffoldLocals,
} from '../../cli/shared/observability-scaffold-locals.js';

const CWD = '/tmp/observability-fixture';

describe('resolveObservabilityScaffoldLocals', () => {
	test('fresh-install defaults (config: null)', () => {
		const locals = resolveObservabilityScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
		});

		expect(locals.appName).toBe('observability-fixture');
		expect(locals.configPath).toBe(
			path.resolve(CWD, 'codegen.config.yaml'),
		);
		expect(locals.appModulePath).toBe(
			path.resolve(CWD, 'src/app.module.ts'),
		);
		expect(locals.bridgeMetricsEnabled).toBe(false);
	});

	test('picks up paths.backend_src override for appModulePath', () => {
		const locals = resolveObservabilityScaffoldLocals({
			cwd: CWD,
			config: { paths: { backend_src: 'packages/api/src' } } as any,
			fileExists: () => false,
		});
		expect(locals.appModulePath).toBe(
			path.resolve(CWD, 'packages/api/src/app.module.ts'),
		);
	});

	test('reads observability.reporters.bridgeMetrics.enabled: true', () => {
		const locals = resolveObservabilityScaffoldLocals({
			cwd: CWD,
			config: {
				observability: {
					reporters: { bridgeMetrics: { enabled: true } },
				},
			} as any,
			fileExists: () => false,
		});
		expect(locals.bridgeMetricsEnabled).toBe(true);
	});

	test('non-literal-true values for bridgeMetrics.enabled do not leak through', () => {
		for (const raw of ['true', 'yes', 1, 'on']) {
			const locals = resolveObservabilityScaffoldLocals({
				cwd: CWD,
				config: {
					observability: {
						reporters: { bridgeMetrics: { enabled: raw } },
					},
				} as any,
				fileExists: () => false,
			});
			expect(locals.bridgeMetricsEnabled).toBe(false);
		}
	});

	test('fileExists probe is permitted to be unused', () => {
		expect(() =>
			resolveObservabilityScaffoldLocals({
				cwd: CWD,
				config: null,
				fileExists: () => {
					throw new Error('should not be called');
				},
			}),
		).not.toThrow();
	});
});

describe('localsToHygenArgs', () => {
	const base: ObservabilityScaffoldLocals = {
		appName: 'demo',
		appModulePath: '/abs/src/app.module.ts',
		configPath: '/abs/codegen.config.yaml',
		bridgeMetricsEnabled: false,
	};

	test('all required flags present', () => {
		const args = localsToHygenArgs(base);
		for (const flag of [
			'--appName',
			'--appModulePath',
			'--configPath',
			'--bridgeMetricsEnabled',
		]) {
			expect(args).toContain(flag);
		}
	});

	test('bridgeMetricsEnabled booleans serialise to literal strings', () => {
		const offArgs = localsToHygenArgs(base);
		const offIdx = offArgs.indexOf('--bridgeMetricsEnabled');
		expect(offIdx).toBeGreaterThanOrEqual(0);
		expect(offArgs[offIdx + 1]).toBe('false');

		const onArgs = localsToHygenArgs({ ...base, bridgeMetricsEnabled: true });
		const onIdx = onArgs.indexOf('--bridgeMetricsEnabled');
		expect(onArgs[onIdx + 1]).toBe('true');
	});

	test('paths pass through as absolute', () => {
		const args = localsToHygenArgs(base);
		expect(args).toContain('/abs/src/app.module.ts');
		expect(args).toContain('/abs/codegen.config.yaml');
	});

	test('round-trips every field (flag → value pairs)', () => {
		const args = localsToHygenArgs(base);
		const pairs: Record<string, string> = {};
		for (let i = 0; i < args.length; i += 2) {
			pairs[args[i]!] = args[i + 1]!;
		}
		expect(pairs['--appName']).toBe('demo');
		expect(pairs['--appModulePath']).toBe('/abs/src/app.module.ts');
		expect(pairs['--configPath']).toBe('/abs/codegen.config.yaml');
		expect(pairs['--bridgeMetricsEnabled']).toBe('false');
	});
});
