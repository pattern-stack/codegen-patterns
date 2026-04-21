/**
 * Unit tests for the EVT-8 events-scaffold locals resolver.
 *
 * Covers:
 *   - default locals on first install (no `events:` block in config)
 *   - multi_tenant: true honored
 *   - multi_tenant non-boolean values do not leak through
 *   - custom `paths.subsystems` flows into schemaPath + generatedKeepPath
 *   - localsToHygenArgs serialises all flags
 *   - localsToHygenArgs emits absolute paths
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
	localsToHygenArgs,
	resolveEventsScaffoldLocals,
	type EventsScaffoldLocals,
} from '../../cli/shared/events-scaffold-locals.js';

const CWD = '/tmp/events-fixture';

describe('resolveEventsScaffoldLocals', () => {
	test('fresh-install defaults (no events block)', () => {
		const locals = resolveEventsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
		});

		expect(locals.multiTenant).toBe(false);
		expect(locals.appName).toBe('events-fixture');
		expect(locals.configPath).toBe(path.resolve(CWD, 'codegen.config.yaml'));
		// Default derives from `backend_src` (fallback 'src') when
		// `paths.subsystems` is unset — matches `project init` layout.
		expect(locals.schemaPath).toBe(
			path.resolve(CWD, 'src/shared/subsystems/events/domain-events.schema.ts'),
		);
		expect(locals.generatedKeepPath).toBe(
			path.resolve(CWD, 'src/shared/subsystems/events/generated/.gitkeep'),
		);
	});

	test('events.multi_tenant: true flows into multiTenant local', () => {
		const locals = resolveEventsScaffoldLocals({
			cwd: CWD,
			config: { events: { multi_tenant: true } } as any,
			fileExists: () => false,
		});
		expect(locals.multiTenant).toBe(true);
	});

	test('events.multi_tenant non-boolean values do not leak through', () => {
		// only the literal `true` flips the flag — defensive against YAML truthy
		// surprises like `'yes'` / `1`.
		for (const raw of ['true', 'yes', 1, 'on']) {
			const locals = resolveEventsScaffoldLocals({
				cwd: CWD,
				config: { events: { multi_tenant: raw } } as any,
				fileExists: () => false,
			});
			expect(locals.multiTenant).toBe(false);
		}
	});

	test('paths.backend_src derives default subsystems root when paths.subsystems is unset', () => {
		const locals = resolveEventsScaffoldLocals({
			cwd: CWD,
			config: { paths: { backend_src: 'packages/api/src' } } as any,
			fileExists: () => false,
		});
		expect(locals.schemaPath).toBe(
			path.resolve(
				CWD,
				'packages/api/src/shared/subsystems/events/domain-events.schema.ts',
			),
		);
		expect(locals.generatedKeepPath).toBe(
			path.resolve(
				CWD,
				'packages/api/src/shared/subsystems/events/generated/.gitkeep',
			),
		);
	});

	test('paths.subsystems takes precedence over paths.backend_src', () => {
		const locals = resolveEventsScaffoldLocals({
			cwd: CWD,
			config: {
				paths: {
					backend_src: 'packages/api/src',
					subsystems: 'custom/subsystems',
				},
			} as any,
			fileExists: () => false,
		});
		expect(locals.schemaPath).toBe(
			path.resolve(CWD, 'custom/subsystems/events/domain-events.schema.ts'),
		);
	});

	test('custom paths.subsystems flows into schemaPath + generatedKeepPath', () => {
		const locals = resolveEventsScaffoldLocals({
			cwd: CWD,
			config: { paths: { subsystems: 'packages/api/src/subsystems' } } as any,
			fileExists: () => false,
		});
		expect(locals.schemaPath).toBe(
			path.resolve(
				CWD,
				'packages/api/src/subsystems/events/domain-events.schema.ts',
			),
		);
		expect(locals.generatedKeepPath).toBe(
			path.resolve(
				CWD,
				'packages/api/src/subsystems/events/generated/.gitkeep',
			),
		);
	});

	test('fileExists probe is permitted to be unused', () => {
		// Today's templates don't need existence probes (inject + force + keep
		// handle their own guards). The resolver accepts the callable for
		// parity with jobs but must not crash when it's a pure `throw`.
		expect(() =>
			resolveEventsScaffoldLocals({
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
	const base: EventsScaffoldLocals = {
		appName: 'demo',
		multiTenant: false,
		configPath: '/abs/codegen.config.yaml',
		schemaPath: '/abs/shared/subsystems/events/domain-events.schema.ts',
		generatedKeepPath: '/abs/shared/subsystems/events/generated/.gitkeep',
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
			'--schemaPath',
			'--generatedKeepPath',
		]) {
			expect(args).toContain(flag);
		}
	});

	test('paths pass through as absolute', () => {
		const args = localsToHygenArgs(base);
		expect(args).toContain('/abs/codegen.config.yaml');
		expect(args).toContain('/abs/shared/subsystems/events/domain-events.schema.ts');
		expect(args).toContain('/abs/shared/subsystems/events/generated/.gitkeep');
	});
});
