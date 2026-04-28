/**
 * Unit tests for the #287 auth-integrations-scaffold locals resolver.
 *
 * Covers:
 *   - default locals on first install
 *   - custom paths.backend_src flows into appModulePath + sharedRoot
 *   - paths.shared overrides the derived sharedRoot
 *   - paths.entities (and legacy paths.entities_dir) overrides the
 *     default integration.yaml location
 *   - authModuleRegistered detection (presence + absence)
 *   - localsToHygenArgs forwards only the keys Hygen needs
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
	localsToHygenArgs,
	resolveAuthIntegrationsScaffoldLocals,
	type AuthIntegrationsScaffoldLocals,
} from '../../cli/shared/auth-integrations-scaffold-locals.js';

const CWD = '/tmp/auth-integrations-fixture';

describe('resolveAuthIntegrationsScaffoldLocals', () => {
	test('fresh-install defaults', () => {
		const locals = resolveAuthIntegrationsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
			readFile: () => null,
		});

		expect(locals.appName).toBe('auth-integrations-fixture');
		expect(locals.appModulePath).toBe(path.resolve(CWD, 'src/app.module.ts'));
		expect(locals.sharedRoot).toBe(path.resolve(CWD, 'src/shared'));
		expect(locals.definitionsPath).toBe(
			path.resolve(CWD, 'definitions/entities/integration.yaml'),
		);
		expect(locals.authModuleRegistered).toBe(false);
	});

	test('paths.backend_src flows through', () => {
		const locals = resolveAuthIntegrationsScaffoldLocals({
			cwd: CWD,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			config: { paths: { backend_src: 'packages/api/src' } } as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(locals.appModulePath).toBe(
			path.resolve(CWD, 'packages/api/src/app.module.ts'),
		);
		expect(locals.sharedRoot).toBe(
			path.resolve(CWD, 'packages/api/src/shared'),
		);
	});

	test('paths.shared overrides the derived sharedRoot', () => {
		const locals = resolveAuthIntegrationsScaffoldLocals({
			cwd: CWD,
			config: {
				paths: { backend_src: 'packages/api/src', shared: 'custom/shared' },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(locals.sharedRoot).toBe(path.resolve(CWD, 'custom/shared'));
	});

	test('paths.entities overrides the default integration.yaml location', () => {
		const locals = resolveAuthIntegrationsScaffoldLocals({
			cwd: CWD,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			config: { paths: { entities: 'definitions/entities' } } as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(locals.definitionsPath).toBe(
			path.resolve(CWD, 'definitions/entities/integration.yaml'),
		);
	});

	test('legacy paths.entities_dir is honored', () => {
		const locals = resolveAuthIntegrationsScaffoldLocals({
			cwd: CWD,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			config: { paths: { entities_dir: 'entities' } } as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(locals.definitionsPath).toBe(
			path.resolve(CWD, 'entities/integration.yaml'),
		);
	});

	test('paths.entities wins over legacy paths.entities_dir', () => {
		const locals = resolveAuthIntegrationsScaffoldLocals({
			cwd: CWD,
			config: {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				paths: { entities: 'a', entities_dir: 'b' } as any,
			},
			fileExists: () => false,
			readFile: () => null,
		});
		expect(locals.definitionsPath).toBe(
			path.resolve(CWD, 'a/integration.yaml'),
		);
	});

	test('authModuleRegistered: true when AuthModule.forRoot present in app.module.ts', () => {
		const locals = resolveAuthIntegrationsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => true,
			readFile: () =>
				"import { AuthModule } from './auth';\n@Module({ imports: [AuthModule.forRoot({})] })",
		});
		expect(locals.authModuleRegistered).toBe(true);
	});

	test('authModuleRegistered: false when app.module.ts is missing or lacks AuthModule.forRoot', () => {
		const missing = resolveAuthIntegrationsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(missing.authModuleRegistered).toBe(false);

		const present = resolveAuthIntegrationsScaffoldLocals({
			cwd: CWD,
			config: null,
			fileExists: () => true,
			readFile: () => '@Module({ imports: [] })',
		});
		expect(present.authModuleRegistered).toBe(false);
	});
});

describe('localsToHygenArgs', () => {
	const base: AuthIntegrationsScaffoldLocals = {
		appName: 'demo',
		appModulePath: '/abs/src/app.module.ts',
		sharedRoot: '/abs/src/shared',
		definitionsPath: '/abs/definitions/entities/integration.yaml',
		authModuleRegistered: false,
	};

	test('forwards only the keys the Hygen template consumes', () => {
		const args = localsToHygenArgs(base);
		expect(args).toContain('--appName');
		expect(args).toContain('--appModulePath');
		// sharedRoot and definitionsPath are consumed by subsystem.ts
		// directly (full-file copies), not by Hygen — must NOT be forwarded.
		expect(args).not.toContain('--sharedRoot');
		expect(args).not.toContain('--definitionsPath');
	});

	test('appModulePath is absolute', () => {
		const args = localsToHygenArgs(base);
		expect(args).toContain('/abs/src/app.module.ts');
	});
});
