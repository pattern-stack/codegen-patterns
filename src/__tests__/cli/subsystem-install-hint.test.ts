/**
 * #663 — `subsystem install` says what is true about `AppModule`.
 *
 * A composer-backed subsystem is composed into `SUBSYSTEM_MODULES` by the
 * regenerated barrel and configured by its config block: the hint says so and
 * names no module to register (a hand registration would be a second
 * `forRoot`). The rest are registered by hand under the module the runtime
 * actually exports — never a name synthesised from the subsystem name.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cli } from 'clipanion';

import subsystemNoun, { HAND_REGISTERED, appModuleWiringHint } from '../../cli/commands/subsystem.js';
import { composesSubsystem } from '../../cli/shared/subsystem-barrel-generator.js';
import { SUBSYSTEMS } from '../../cli/shared/subsystem-detect.js';
import { setJsonMode } from '../../cli/ui/json.js';

const tempDirs: string[] = [];

afterEach(() => {
	setJsonMode(false);
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
	tempDirs.length = 0;
});

function mkProject(runtime: 'vendored' | 'package'): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-hint-'));
	tempDirs.push(dir);
	fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), `runtime: ${runtime}\npaths:\n  backend_src: src\n`);
	return dir;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
	const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
	for (const Cls of subsystemNoun.commandClasses) cli.register(Cls);
	const chunks: string[] = [];
	const push = (...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' ') + '\n');
	};
	const orig = {
		write: process.stdout.write.bind(process.stdout),
		log: console.log,
		warn: console.warn,
		error: console.error,
	};
	process.stdout.write = ((data: string | Uint8Array) => {
		chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
		return true;
	}) as typeof process.stdout.write;
	console.log = push;
	console.warn = push;
	console.error = push;
	try {
		const code = await cli.run(argv);
		return { code, out: chunks.join('') };
	} finally {
		process.stdout.write = orig.write;
		console.log = orig.log;
		console.warn = orig.warn;
		console.error = orig.error;
	}
}

const COMPOSED = ['events', 'jobs', 'bridge', 'integration', 'observability'] as const;

describe('appModuleWiringHint', () => {
	test('the composed set is exactly the barrel composers', () => {
		const composed = SUBSYSTEMS.map((s) => s.name).filter((n) => composesSubsystem(n));
		expect(composed.sort()).toEqual([...COMPOSED].sort());
	});

	for (const name of COMPOSED) {
		test(`${name} — composed through SUBSYSTEM_MODULES, configured by its block, no registration`, () => {
			const hint = appModuleWiringHint(name, 'drizzle');
			expect(hint).toBe(
				`${name} is composed into SUBSYSTEM_MODULES by the regenerated <generated>/subsystems.ts (spread once into AppModule) and configured by its \`${name}:\` block in codegen.config.yaml — do not register it in app.module.ts.`,
			);
			expect(hint).not.toContain('Register');
		});
	}

	test('the hand-registered table is exactly the non-composed subsystems install and remove reach', () => {
		const shortCircuited = new Set(['openapi-config', 'auth-integrations']);
		const expected = SUBSYSTEMS.map((s) => s.name).filter((n) => !composesSubsystem(n) && !shortCircuited.has(n));
		expect(Object.keys(HAND_REGISTERED).sort()).toEqual(expected.sort());
	});

	test('cache / storage — the real module and its forRoot({ backend })', () => {
		expect(appModuleWiringHint('cache', 'memory')).toBe(
			"Register CacheModule.forRoot({ backend: 'memory' }) in your app.module.ts — SUBSYSTEM_MODULES does not compose cache.",
		);
		expect(appModuleWiringHint('storage', 'local')).toBe(
			"Register StorageModule.forRoot({ backend: 'local' }) in your app.module.ts — SUBSYSTEM_MODULES does not compose storage.",
		);
	});

	test('auth — AuthModule with its real options, not { backend }', () => {
		expect(appModuleWiringHint('auth', 'drizzle')).toBe(
			'Register AuthModule.forRoot({ encryptionKey, oauthStateStore, enableController, redirectUriBase }) in your app.module.ts — SUBSYSTEM_MODULES does not compose auth.',
		);
	});

	test('a subsystem with no module to wire throws rather than synthesising one', () => {
		expect(() => appModuleWiringHint('openapi-config', 'config-only')).toThrow(
			"'openapi-config' is neither composed nor hand-registered",
		);
	});
});

describe('subsystem install prints the true AppModule hint', () => {
	test('vendored jobs — composed hint, no JobsModule', async () => {
		const root = mkProject('vendored');
		const { code, out } = await run(['subsystem', 'install', 'jobs', '--force', '--cwd', root]);
		expect(code).toBe(0);
		expect(out).toContain(appModuleWiringHint('jobs', 'drizzle'));
		expect(out).not.toContain('JobsModule');
	}, 60_000);

	test('vendored cache — names CacheModule', async () => {
		const root = mkProject('vendored');
		const { code, out } = await run(['subsystem', 'install', 'cache', '--force', '--cwd', root]);
		expect(code).toBe(0);
		expect(out).toContain(appModuleWiringHint('cache', 'drizzle'));
	});

	test('package events — composed hint', async () => {
		const root = mkProject('package');
		const { code, out } = await run(['subsystem', 'install', 'events', '--force', '--cwd', root]);
		expect(code).toBe(0);
		expect(out).toContain(appModuleWiringHint('events', 'drizzle'));
	});

	test('package storage — names StorageModule (the barrel does not compose it)', async () => {
		const root = mkProject('package');
		const { code, out } = await run(['subsystem', 'install', 'storage', '--force', '--cwd', root]);
		expect(code).toBe(0);
		expect(out).toContain(appModuleWiringHint('storage', 'local'));
	});

	test('vendored remove jobs — nothing to remove from app.module.ts', async () => {
		const root = mkProject('vendored');
		expect((await run(['subsystem', 'install', 'jobs', '--force', '--cwd', root])).code).toBe(0);
		const { code, out } = await run(['subsystem', 'remove', 'jobs', '--force', '--cwd', root]);
		expect(code).toBe(0);
		expect(out).toContain('1. Nothing to remove from app.module.ts — SUBSYSTEM_MODULES no longer composes jobs.');
		expect(out).not.toContain('JobsModule');
	}, 60_000);
});
