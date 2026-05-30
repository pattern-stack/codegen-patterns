/**
 * Unit tests for the SYNC-7 integration-scaffold locals resolver.
 *
 * Mirrors events-scaffold-locals.test.ts. Covers:
 *   - default locals on first install (no `integration:` block in config)
 *   - multi_tenant: true honored
 *   - multi_tenant non-boolean values do not leak through
 *   - custom `paths.subsystems` flows into schemaPath
 *   - localsToHygenArgs serialises all flags
 *   - localsToHygenArgs emits absolute paths
 *   - NO generatedKeepPath — integration ships no codegen artifacts
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
	localsToHygenArgs,
	resolveIntegrationScaffoldLocals,
	type IntegrationScaffoldLocals,
} from '../../cli/shared/integration-scaffold-locals.js';

const CWD = '/tmp/integration-fixture';

describe('resolveIntegrationScaffoldLocals', () => {
	test('fresh-install defaults (no integration block)', () => {
		const locals = resolveIntegrationScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
		});

		expect(locals.multiTenant).toBe(false);
		expect(locals.appName).toBe('integration-fixture');
		expect(locals.configPath).toBe(path.resolve(CWD, 'codegen.config.yaml'));
		expect(locals.schemaPath).toBe(
			path.resolve(CWD, 'src/shared/subsystems/integration/integration-audit.schema.ts'),
		);
	});

	test('integration.multi_tenant: true flows into multiTenant local', () => {
		const locals = resolveIntegrationScaffoldLocals({
			cwd: CWD,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			config: { integration: { multi_tenant: true } } as any,
			fileExists: () => false,
		});
		expect(locals.multiTenant).toBe(true);
	});

	test('integration.multi_tenant non-boolean values do not leak through', () => {
		for (const raw of ['true', 'yes', 1, 'on']) {
			const locals = resolveIntegrationScaffoldLocals({
				cwd: CWD,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				config: { integration: { multi_tenant: raw } } as any,
				fileExists: () => false,
			});
			expect(locals.multiTenant).toBe(false);
		}
	});

	test('paths.backend_src derives default subsystems root when paths.subsystems is unset', () => {
		const locals = resolveIntegrationScaffoldLocals({
			cwd: CWD,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			config: { paths: { backend_src: 'packages/api/src' } } as any,
			fileExists: () => false,
		});
		expect(locals.schemaPath).toBe(
			path.resolve(
				CWD,
				'packages/api/src/shared/subsystems/integration/integration-audit.schema.ts',
			),
		);
	});

	test('paths.subsystems takes precedence over paths.backend_src', () => {
		const locals = resolveIntegrationScaffoldLocals({
			cwd: CWD,
			config: {
				paths: {
					backend_src: 'packages/api/src',
					subsystems: 'custom/subsystems',
				},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any,
			fileExists: () => false,
		});
		expect(locals.schemaPath).toBe(
			path.resolve(CWD, 'custom/subsystems/integration/integration-audit.schema.ts'),
		);
	});

	test('custom paths.subsystems flows into schemaPath', () => {
		const locals = resolveIntegrationScaffoldLocals({
			cwd: CWD,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			config: { paths: { subsystems: 'packages/api/src/subsystems' } } as any,
			fileExists: () => false,
		});
		expect(locals.schemaPath).toBe(
			path.resolve(
				CWD,
				'packages/api/src/subsystems/integration/integration-audit.schema.ts',
			),
		);
	});

	test('fileExists probe is permitted to be unused', () => {
		expect(() =>
			resolveIntegrationScaffoldLocals({
				cwd: CWD,
				config: null,
				fileExists: () => {
					throw new Error('should not be called');
				},
			}),
		).not.toThrow();
	});

	test('no generatedKeepPath on the locals shape', () => {
		// SYNC-7 intentionally omits a generated/ dir. Any future agent who
		// tries to add it should fail this test first.
		const locals = resolveIntegrationScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
		});
		expect('generatedKeepPath' in locals).toBe(false);
	});
});

describe('localsToHygenArgs', () => {
	const base: IntegrationScaffoldLocals = {
		appName: 'demo',
		multiTenant: false,
		configPath: '/abs/codegen.config.yaml',
		schemaPath: '/abs/shared/subsystems/integration/integration-audit.schema.ts',
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
		for (const flag of ['--appName', '--multiTenant', '--configPath', '--schemaPath']) {
			expect(args).toContain(flag);
		}
	});

	test('no --generatedKeepPath flag', () => {
		const args = localsToHygenArgs(base);
		expect(args).not.toContain('--generatedKeepPath');
	});

	test('paths pass through as absolute', () => {
		const args = localsToHygenArgs(base);
		expect(args).toContain('/abs/codegen.config.yaml');
		expect(args).toContain('/abs/shared/subsystems/integration/integration-audit.schema.ts');
	});
});
