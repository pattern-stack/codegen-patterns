/**
 * Unit tests for the #287 auth-integrations-scaffold locals resolver.
 *
 * Covers:
 *   - default locals on first install
 *   - custom paths.backend_src flows into appModulePath + vendorRoot
 *   - paths.modules_dir overrides the derived vendorRoot (#303 fix #5)
 *   - paths.entities (and legacy paths.entities_dir) overrides the
 *     default connection.yaml location
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
		expect(locals.vendorRoot).toBe(path.resolve(CWD, 'src/modules'));
		expect(locals.definitionsPath).toBe(
			path.resolve(CWD, 'definitions/entities/connection.yaml'),
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
		expect(locals.vendorRoot).toBe(
			path.resolve(CWD, 'packages/api/src/modules'),
		);
	});

	test('paths.modules_dir overrides the derived vendorRoot (#303 fix #5)', () => {
		const locals = resolveAuthIntegrationsScaffoldLocals({
			cwd: CWD,
			config: {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				paths: { backend_src: 'apps/api/src', modules_dir: 'apps/api/src/features' },
			} as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(locals.vendorRoot).toBe(path.resolve(CWD, 'apps/api/src/features'));
	});

	test('paths.entities overrides the default connection.yaml location', () => {
		const locals = resolveAuthIntegrationsScaffoldLocals({
			cwd: CWD,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			config: { paths: { entities: 'definitions/entities' } } as any,
			fileExists: () => false,
			readFile: () => null,
		});
		expect(locals.definitionsPath).toBe(
			path.resolve(CWD, 'definitions/entities/connection.yaml'),
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
			path.resolve(CWD, 'entities/connection.yaml'),
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
			path.resolve(CWD, 'a/connection.yaml'),
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
		vendorRoot: '/abs/src/modules',
		definitionsPath: '/abs/definitions/entities/connection.yaml',
		authModuleRegistered: false,
	};

	test('forwards only the keys the Hygen template consumes', () => {
		const args = localsToHygenArgs(base);
		expect(args).toContain('--appName');
		expect(args).toContain('--appModulePath');
		// vendorRoot and definitionsPath are consumed by subsystem.ts
		// directly (full-file copies), not by Hygen — must NOT be forwarded.
		expect(args).not.toContain('--vendorRoot');
		expect(args).not.toContain('--definitionsPath');
	});

	test('appModulePath is absolute', () => {
		const args = localsToHygenArgs(base);
		expect(args).toContain('/abs/src/app.module.ts');
	});
});
