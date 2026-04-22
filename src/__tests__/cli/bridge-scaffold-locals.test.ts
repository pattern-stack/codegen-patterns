/**
 * Unit tests for the BRIDGE-9 bridge-scaffold locals resolver.
 *
 * Mirrors `events-scaffold-locals.test.ts`. Bridge has the LEAN scaffold —
 * no schema template — so the locals shape is `events` minus `schemaPath`.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
	localsToHygenArgs,
	resolveBridgeScaffoldLocals,
	type BridgeScaffoldLocals,
} from '../../cli/shared/bridge-scaffold-locals.js';

const CWD = '/tmp/bridge-fixture';

describe('resolveBridgeScaffoldLocals', () => {
	test('fresh-install defaults (no bridge block)', () => {
		const locals = resolveBridgeScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
		});

		expect(locals.multiTenant).toBe(false);
		expect(locals.appName).toBe('bridge-fixture');
		expect(locals.configPath).toBe(path.resolve(CWD, 'codegen.config.yaml'));
		expect(locals.generatedKeepPath).toBe(
			path.resolve(CWD, 'src/shared/subsystems/bridge/generated/.gitkeep'),
		);
	});

	test('bridge.multi_tenant: true flows into multiTenant local', () => {
		const locals = resolveBridgeScaffoldLocals({
			cwd: CWD,
			config: { bridge: { multi_tenant: true } } as any,
			fileExists: () => false,
		});
		expect(locals.multiTenant).toBe(true);
	});

	test('bridge.multi_tenant non-boolean values do not leak through', () => {
		for (const raw of ['true', 'yes', 1, 'on']) {
			const locals = resolveBridgeScaffoldLocals({
				cwd: CWD,
				config: { bridge: { multi_tenant: raw } } as any,
				fileExists: () => false,
			});
			expect(locals.multiTenant).toBe(false);
		}
	});

	test('paths.backend_src derives default subsystems root when paths.subsystems is unset', () => {
		const locals = resolveBridgeScaffoldLocals({
			cwd: CWD,
			config: { paths: { backend_src: 'packages/api/src' } } as any,
			fileExists: () => false,
		});
		expect(locals.generatedKeepPath).toBe(
			path.resolve(
				CWD,
				'packages/api/src/shared/subsystems/bridge/generated/.gitkeep',
			),
		);
	});

	test('paths.subsystems takes precedence over paths.backend_src', () => {
		const locals = resolveBridgeScaffoldLocals({
			cwd: CWD,
			config: {
				paths: {
					backend_src: 'packages/api/src',
					subsystems: 'custom/subsystems',
				},
			} as any,
			fileExists: () => false,
		});
		expect(locals.generatedKeepPath).toBe(
			path.resolve(CWD, 'custom/subsystems/bridge/generated/.gitkeep'),
		);
	});

	test('fileExists probe is permitted to be unused', () => {
		expect(() =>
			resolveBridgeScaffoldLocals({
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
	const base: BridgeScaffoldLocals = {
		appName: 'demo',
		multiTenant: false,
		configPath: '/abs/codegen.config.yaml',
		generatedKeepPath: '/abs/shared/subsystems/bridge/generated/.gitkeep',
	};

	test('multiTenant booleans serialise to the literal strings Hygen expects', () => {
		const offArgs = localsToHygenArgs(base);
		const offIdx = offArgs.indexOf('--multiTenant');
		expect(offIdx).toBeGreaterThanOrEqual(0);
		expect(offArgs[offIdx + 1]).toBe('false');

		const onArgs = localsToHygenArgs({ ...base, multiTenant: true });
		const onIdx = onArgs.indexOf('--multiTenant');
		expect(onArgs[onIdx + 1]).toBe('true');
	});

	test('all required flags present', () => {
		const args = localsToHygenArgs(base);
		for (const flag of [
			'--appName',
			'--multiTenant',
			'--configPath',
			'--generatedKeepPath',
		]) {
			expect(args).toContain(flag);
		}
	});

	test('paths pass through as absolute', () => {
		const args = localsToHygenArgs(base);
		expect(args).toContain('/abs/codegen.config.yaml');
		expect(args).toContain('/abs/shared/subsystems/bridge/generated/.gitkeep');
	});
});
