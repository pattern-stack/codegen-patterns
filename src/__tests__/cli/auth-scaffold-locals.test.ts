/**
 * Unit tests for the #287 auth-scaffold locals resolver.
 *
 * Mirrors sync-scaffold-locals.test.ts. Covers:
 *   - default locals on first install (no `auth:` block in config)
 *   - custom `auth.redirect_uri_base` flows through
 *   - non-string `auth.redirect_uri_base` does not leak through
 *   - `paths.backend_src` flows into appModulePath + schemaPath
 *   - `paths.subsystems` takes precedence over `paths.backend_src` for schemaPath
 *   - tokenEncryptionKey is 44-char base64 (32 bytes)
 *   - localsToHygenArgs serialises all flags + paths are absolute
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
	localsToHygenArgs,
	resolveAuthScaffoldLocals,
	type AuthScaffoldLocals,
} from '../../cli/shared/auth-scaffold-locals.js';

const CWD = '/tmp/auth-fixture';

describe('resolveAuthScaffoldLocals', () => {
	test('fresh-install defaults (no auth block)', () => {
		const locals = resolveAuthScaffoldLocals({
			cwd: CWD,
			config: null,
		});

		expect(locals.appName).toBe('auth-fixture');
		expect(locals.configPath).toBe(path.resolve(CWD, 'codegen.config.yaml'));
		expect(locals.schemaPath).toBe(
			path.resolve(
				CWD,
				'src/shared/subsystems/auth/auth-oauth-state.schema.ts',
			),
		);
		expect(locals.appModulePath).toBe(path.resolve(CWD, 'src/app.module.ts'));
		expect(locals.envConfigPath).toBe(path.resolve(CWD, '.env.config'));
		expect(locals.redirectUriBase).toBe('http://localhost:3000');
	});

	test('auth.redirect_uri_base override flows through', () => {
		const locals = resolveAuthScaffoldLocals({
			cwd: CWD,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			config: { auth: { redirect_uri_base: 'https://api.example.com' } } as any,
		});
		expect(locals.redirectUriBase).toBe('https://api.example.com');
	});

	test('non-string auth.redirect_uri_base does not leak through', () => {
		for (const raw of [null, undefined, 1, true, {}, []]) {
			const locals = resolveAuthScaffoldLocals({
				cwd: CWD,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				config: { auth: { redirect_uri_base: raw } } as any,
				fileExists: () => false,
			});
			expect(locals.redirectUriBase).toBe('http://localhost:3000');
		}
	});

	test('paths.backend_src flows into appModulePath + schemaPath', () => {
		const locals = resolveAuthScaffoldLocals({
			cwd: CWD,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			config: { paths: { backend_src: 'packages/api/src' } } as any,
		});
		expect(locals.appModulePath).toBe(
			path.resolve(CWD, 'packages/api/src/app.module.ts'),
		);
		expect(locals.schemaPath).toBe(
			path.resolve(
				CWD,
				'packages/api/src/shared/subsystems/auth/auth-oauth-state.schema.ts',
			),
		);
	});

	test('paths.subsystems takes precedence for schemaPath', () => {
		const locals = resolveAuthScaffoldLocals({
			cwd: CWD,
			config: {
				paths: {
					backend_src: 'packages/api/src',
					subsystems: 'custom/subsystems',
				},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any,
		});
		expect(locals.schemaPath).toBe(
			path.resolve(CWD, 'custom/subsystems/auth/auth-oauth-state.schema.ts'),
		);
	});

	test('tokenEncryptionKey is 44-char base64 (32 bytes)', () => {
		const locals = resolveAuthScaffoldLocals({
			cwd: CWD,
			config: null,
		});
		// 32 bytes encoded as base64 = 44 ascii chars (with one '=' pad).
		expect(locals.tokenEncryptionKey.length).toBe(44);
		// Must be valid base64.
		expect(/^[A-Za-z0-9+/]+=*$/.test(locals.tokenEncryptionKey)).toBe(true);
		// And must round-trip to 32 bytes.
		const buf = Buffer.from(locals.tokenEncryptionKey, 'base64');
		expect(buf.length).toBe(32);
	});

	test('successive resolves produce different keys', () => {
		// Sanity: not crypto-strength testing, just that we're not memoising
		// or hard-coding the value somewhere.
		const a = resolveAuthScaffoldLocals({
			cwd: CWD,
			config: null,
		});
		const b = resolveAuthScaffoldLocals({
			cwd: CWD,
			config: null,
		});
		expect(a.tokenEncryptionKey).not.toBe(b.tokenEncryptionKey);
	});

});

describe('localsToHygenArgs', () => {
	const base: AuthScaffoldLocals = {
		appName: 'demo',
		configPath: '/abs/codegen.config.yaml',
		schemaPath: '/abs/shared/subsystems/auth/auth-oauth-state.schema.ts',
		appModulePath: '/abs/src/app.module.ts',
		envConfigPath: '/abs/.env.config',
		redirectUriBase: 'http://localhost:3000',
		tokenEncryptionKey: 'AAAA'.repeat(11), // 44 chars, b64-shaped
	};

	test('all required flags present', () => {
		const args = localsToHygenArgs(base);
		for (const flag of [
			'--appName',
			'--configPath',
			'--schemaPath',
			'--appModulePath',
			'--envConfigPath',
			'--redirectUriBase',
			'--tokenEncryptionKey',
		]) {
			expect(args).toContain(flag);
		}
	});

	test('paths pass through as absolute', () => {
		const args = localsToHygenArgs(base);
		expect(args).toContain('/abs/codegen.config.yaml');
		expect(args).toContain('/abs/shared/subsystems/auth/auth-oauth-state.schema.ts');
		expect(args).toContain('/abs/src/app.module.ts');
		expect(args).toContain('/abs/.env.config');
	});

	test('tokenEncryptionKey forwarded', () => {
		const args = localsToHygenArgs(base);
		const idx = args.indexOf('--tokenEncryptionKey');
		expect(args[idx + 1]).toBe(base.tokenEncryptionKey);
	});
});
