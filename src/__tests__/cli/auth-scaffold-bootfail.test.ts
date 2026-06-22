/**
 * ADR-043 — closed-by-default scaffold emission.
 *
 * Asserts the boot-fail / RequesterContext boundary is wired into the HTTP
 * entrypoint (`main.ts`) and ONLY there:
 *   - package mode: main.ts imports the auth barrel + calls
 *     installRequesterContext + carries the boot-fail check.
 *   - vendored mode: main.ts carries the deferral hint (no dangling import on a
 *     bare scaffold), pointing at `project upgrade-auth`.
 *   - the jobs worker template never carries the boot-fail — a worker process
 *     imports AppModule whole but never serves HTTP, so it must not trip it.
 */
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'bun:test';
import { mainTsContent } from '../../cli/shared/init-scaffold.js';
import { AuthConfigSchema } from '../../schema/codegen-config.schema.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

describe('main.ts boot-fail emission (ADR-043)', () => {
	test('package mode wires the boundary + boot-fail', () => {
		const main = mainTsContent('package');
		expect(main).toContain("from '@pattern-stack/codegen/subsystems'");
		expect(main).toContain('installRequesterContext(app)');
		expect(main).toContain('AUTH_USER_CONTEXT');
		expect(main).toContain('devAllowAnonymous');
		expect(main).toContain('FATAL');
		// The check precedes app.listen() (HTTP-entrypoint gating).
		expect(main.indexOf('installRequesterContext(app)')).toBeLessThan(main.indexOf('app.listen'));
	});

	test('vendored mode defers wiring to project upgrade-auth (no dangling import)', () => {
		const main = mainTsContent('vendored');
		expect(main).not.toContain('installRequesterContext(app)');
		expect(main).not.toContain("from './shared/subsystems/auth'");
		expect(main).toContain('project upgrade-auth');
	});

	test('the jobs worker template never carries the boot-fail (main.ts only)', () => {
		const worker = fs.readFileSync(
			path.join(REPO_ROOT, 'templates', 'subsystem', 'jobs', 'worker.ejs.t'),
			'utf-8',
		);
		expect(worker).not.toContain('installRequesterContext');
		expect(worker).not.toContain('devAllowAnonymous');
		expect(worker).not.toContain('FATAL: entity HTTP controllers');
	});
});

describe('AuthConfigSchema (ADR-043)', () => {
	test('defaults devAllowAnonymous to false', () => {
		expect(AuthConfigSchema.parse(undefined)).toEqual({ devAllowAnonymous: false });
		expect(AuthConfigSchema.parse({})).toEqual({ devAllowAnonymous: false });
	});

	test('accepts an explicit true', () => {
		expect(AuthConfigSchema.parse({ devAllowAnonymous: true })).toEqual({ devAllowAnonymous: true });
	});

	test('rejects unknown keys (strict)', () => {
		expect(() => AuthConfigSchema.parse({ nope: 1 })).toThrow();
	});
});
