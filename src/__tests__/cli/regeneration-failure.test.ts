/**
 * JOBS-0 (#655) — generated files the app imports are never optional output.
 *
 * A failed regeneration of `<generated>/modules.ts`, `schema.ts`,
 * `subsystems.ts`, `app-config.ts` or `subsystems-schema.ts` fails the command:
 * exit 1, an error naming the file (text and JSON mode). The failure is a real
 * one — a directory sits where the file must be written (`EISDIR`), no mocks.
 * The smokes prove the happy path.
 *
 * JOBS-1 (#661): `subsystem install` (both runtime paths) regenerates those
 * files from the config block it just injected, not the config read before.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cli } from 'clipanion';

import entityNoun from '../../cli/commands/entity.js';
import subsystemNoun from '../../cli/commands/subsystem.js';
import { setJsonMode } from '../../cli/ui/json.js';

const tempDirs: string[] = [];

afterEach(() => {
	setJsonMode(false);
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
	tempDirs.length = 0;
});

function mkProject(config: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-fail-'));
	tempDirs.push(dir);
	fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), config);
	return dir;
}

/** Occupy `<root>/<rel>` with a directory so writing the file there fails. */
function block(root: string, rel: string): string {
	const abs = path.join(root, rel);
	fs.mkdirSync(abs, { recursive: true });
	return abs;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
	const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
	for (const Cls of [...entityNoun.commandClasses, ...subsystemNoun.commandClasses]) cli.register(Cls);
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

describe('entity new fails when a barrel cannot be regenerated', () => {
	// The only entity YAML is invalid, so `--all` generates nothing with hygen
	// and goes straight to the barrel post-step.
	const project = () => {
		const root = mkProject('paths:\n  entities: entities\n');
		fs.mkdirSync(path.join(root, 'entities'));
		fs.writeFileSync(path.join(root, 'entities', 'example.yaml'), '# placeholder\n');
		return root;
	};

	test('modules.ts — text mode names the file, exit 1', async () => {
		const root = project();
		const file = block(root, 'src/generated/modules.ts');
		const { code, out } = await run(['entity', 'new', '--all', '--force', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain(`could not regenerate ${file}: EISDIR`);
		expect(out).not.toContain('barrel regeneration failed');
	});

	test('app-config.ts — JSON mode carries status, file and error', async () => {
		const root = project();
		const file = block(root, 'src/generated/app-config.ts');
		const { code, out } = await run(['entity', 'new', '--all', '--force', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out);
		expect(payload).toMatchObject({ command: 'entity new', status: 'error', file });
		expect(payload.error).toContain(`could not regenerate ${file}: EISDIR`);
	});
});

describe('subsystem install fails when a barrel cannot be regenerated', () => {
	test('vendored: subsystems.ts', async () => {
		const root = mkProject('runtime: vendored\npaths:\n  backend_src: src\n');
		const file = block(root, 'src/generated/subsystems.ts');
		const { code, out } = await run(['subsystem', 'install', 'events', '--force', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain(`could not regenerate ${file}: EISDIR`);
		expect(out).not.toContain('subsystem installed with');
	});

	test('vendored, JSON mode: regenerates (and fails) too', async () => {
		const root = mkProject('runtime: vendored\npaths:\n  backend_src: src\n');
		const file = block(root, 'src/generated/app-config.ts');
		const { code, out } = await run(['subsystem', 'install', 'events', '--force', '--json', '--cwd', root]);
		expect(code).toBe(1);
		expect(JSON.parse(out)).toMatchObject({ command: 'subsystem install', status: 'error', file });
	});

	test('package: subsystems-schema.ts', async () => {
		const root = mkProject('paths:\n  backend_src: src\n');
		const file = block(root, 'src/generated/subsystems-schema.ts');
		const { code, out } = await run(['subsystem', 'install', 'events', '--force', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain(`could not regenerate ${file}: EISDIR`);
	});
});

describe('subsystem remove fails when the barrel cannot be regenerated', () => {
	test('vendored: subsystems.ts', async () => {
		const root = mkProject('runtime: vendored\npaths:\n  backend_src: src\n');
		expect((await run(['subsystem', 'install', 'events', '--force', '--cwd', root])).code).toBe(0);
		const file = path.join(root, 'src/generated/subsystems.ts');
		fs.rmSync(file);
		block(root, 'src/generated/subsystems.ts');
		const { code, out } = await run(['subsystem', 'remove', 'events', '--yes', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain(`could not regenerate ${file}: EISDIR`);
	});
});

describe('subsystem install openapi-config fails when app-config.ts cannot be regenerated', () => {
	test('names the file, exit 1 — not a stack trace', async () => {
		const root = mkProject('paths:\n  backend_src: src\n');
		const file = block(root, 'src/generated/app-config.ts');
		const { code, out } = await run(['subsystem', 'install', 'openapi-config', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain(`could not regenerate ${file}: EISDIR`);
		expect(out).not.toContain('openapi config block');
	});
});

describe('subsystem install --json (vendored) regenerates the barrel', () => {
	test('writes subsystems.ts and app-config.ts', async () => {
		const root = mkProject('runtime: vendored\npaths:\n  backend_src: src\n');
		const { code, out } = await run(['subsystem', 'install', 'events', '--force', '--json', '--cwd', root]);
		expect(code).toBe(0);
		expect(JSON.parse(out)).toMatchObject({ command: 'subsystem install', subsystem: 'events' });
		expect(fs.readFileSync(path.join(root, 'src/generated/subsystems.ts'), 'utf-8')).toContain(
			'EventsModule.forRoot(',
		);
		expect(fs.existsSync(path.join(root, 'src/generated/app-config.ts'))).toBe(true);
	});
});

describe('subsystem install regenerates from the config block it just wrote (JOBS-1, #661)', () => {
	const drizzleExt = '{ drizzle: { pollIntervalMs: 1000 } }';
	for (const runtime of ['vendored', 'package'] as const) {
		test(`${runtime}: jobs — subsystems.ts and app-config.ts carry the injected jobs: block`, async () => {
			const root = mkProject(`runtime: ${runtime}\npaths:\n  backend_src: src\n`);
			const { code } = await run(['subsystem', 'install', 'jobs', '--force', '--cwd', root]);
			expect(code).toBe(0);
			expect(fs.readFileSync(path.join(root, 'codegen.config.yaml'), 'utf-8')).toContain('worker_mode: embedded');
			const barrel = fs.readFileSync(path.join(root, 'src/generated/subsystems.ts'), 'utf-8');
			expect(barrel).toContain(`JobsDomainModule.forRoot({ backend: 'drizzle', extensions: ${drizzleExt}, pools: jobPools })`);
			expect(barrel).toContain(
				`JobWorkerModule.forRoot({ mode: 'embedded', backend: 'drizzle', domainModuleExtensions: ${drizzleExt}, domainModulePools: jobPools })`,
			);
			const appConfig = fs.readFileSync(path.join(root, 'src/generated/app-config.ts'), 'utf-8');
			expect(appConfig).toMatch(
				/export const jobWorkerOptions = \{[^}]*"backend": "drizzle",\s*"domainModuleExtensions": \{\s*"drizzle": \{\s*"pollIntervalMs": 1000\s*\}/,
			);
		}, 60_000);
	}
});
