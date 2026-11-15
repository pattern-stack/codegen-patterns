/**
 * `project surface --json` — every failure prints `{ command: 'project surface', status: 'error', error }` and
 * exits non-zero, never an empty stdout (the #669 convention `entity new` follows).
 *
 * Studio's `GET /api/surface` forwards `error` as its 502 detail, so the API tab shows the generator's own reason
 * (STUDIO-2 §4). Before, `printError` — a no-op in JSON mode — left stdout and stderr both empty, and the tab could
 * only say "project surface failed".
 */

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cli } from 'clipanion';

import projectNoun from '../../cli/commands/project.js';
import { setJsonMode } from '../../cli/ui/json.js';
import { demoEntitiesDir } from '../../studio/demo/materialize.js';

const tempDirs: string[] = [];

afterEach(() => {
	setJsonMode(false);
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
	tempDirs.length = 0;
});

/** The Studio demo's entities, in a package-mode project. */
function mkDemoProject(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-surface-json-'));
	tempDirs.push(root);
	fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'paths:\n  entities: entities\n');
	fs.cpSync(demoEntitiesDir(), path.join(root, 'entities'), { recursive: true });
	return root;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
	const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
	for (const Cls of projectNoun.commandClasses) cli.register(Cls);
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

describe('project surface --json — failures carry a payload (#669)', () => {
	test('the demo derives: exit 0, a surface, no error', async () => {
		const root = mkDemoProject();
		const { code, out } = await run(['project', 'surface', '--json', '--cwd', root]);
		expect(code).toBe(0);
		const payload = JSON.parse(out) as { status?: string; surface?: { entities: Record<string, unknown> } };
		expect(payload.status).toBeUndefined();
		expect(Object.keys(payload.surface?.entities ?? {}).sort()).toEqual(['account', 'contact', 'opportunity']);
	});

	test('an `api.includes` path that names no relation: exit 1, the derivation error in the payload', async () => {
		const root = mkDemoProject();
		fs.appendFileSync(
			path.join(root, 'entities', 'account.yaml'),
			'api:\n  includes:\n    find_by_id:\n      max_depth: 1\n      paths: [nonexistent]\n',
		);
		const { code, out } = await run(['project', 'surface', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out) as { command: string; status: string; error: string };
		expect(payload.command).toBe('project surface');
		expect(payload.status).toBe('error');
		expect(payload.error).toContain("account.api.includes.find_by_id: 'nonexistent' names no relation at 'nonexistent'");
	});

	test('no entity directory: exit 1, the error in the payload', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-surface-json-'));
		tempDirs.push(root);
		fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'paths:\n  entities: entities\n');
		const { code, out } = await run(['project', 'surface', '--json', '--cwd', root]);
		expect(code).toBe(1);
		expect(JSON.parse(out)).toEqual({
			command: 'project surface',
			status: 'error',
			error: `Entity directory not found: ${path.join(root, 'entities')}`,
		});
	});

	test('an unknown `--entity`: exit 1, the error in the payload', async () => {
		const root = mkDemoProject();
		const { code, out } = await run(['project', 'surface', '--json', '--entity', 'nope', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out) as { status: string; error: string };
		expect(payload.status).toBe('error');
		expect(payload.error).toBe(`No entity 'nope' in ${path.join(root, 'entities')}`);
	});

	test('an invalid entity YAML is a named rejection, not the loader invariant (#915)', async () => {
		const root = mkDemoProject();
		fs.writeFileSync(
			path.join(root, 'entities', 'bad.yaml'),
			'entity:\n  name: bad\n  plural: bads\nconfig:\n  x: 1\nfields:\n  title:\n    type: string\n',
		);
		const { code, out } = await run(['project', 'surface', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out) as { status: string; error: string; failed: { name: string; details: string[] }[] };
		expect(payload.status).toBe('error');
		expect(payload.error).toContain('bad.yaml');
		expect(payload.error).not.toContain('pre-flight should have stopped');
		expect(payload.failed.map((f) => f.name)).toEqual(['bad.yaml']);

		const text = await run(['project', 'surface', '--cwd', root]);
		expect(text.code).toBe(1);
		expect(text.out).toContain('bad.yaml');
		expect(text.out).not.toContain('pre-flight should have stopped');
	});

	test('an invalid relationship YAML is named too, by the pre-flight rule', async () => {
		const root = mkDemoProject();
		fs.mkdirSync(path.join(root, 'relationships'));
		fs.writeFileSync(path.join(root, 'relationships', 'broken_rel.yaml'), 'relationship:\n  name: broken_rel\n  from: account\n');
		const { code, out } = await run(['project', 'surface', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out) as { error: string; failed: { name: string }[] };
		expect(payload.failed.map((f) => f.name)).toEqual(['broken_rel.yaml']);
		expect(payload.error).toContain('broken_rel.yaml');
	});

	test('loadProjectApiContext on an invalid relationship throws (the pre-flight skipped)', async () => {
		const { loadProjectApiContext } = await import('../../derived/api/project.js');
		const root = mkDemoProject();
		fs.mkdirSync(path.join(root, 'relationships'));
		fs.writeFileSync(path.join(root, 'relationships', 'broken_rel.yaml'), 'relationship:\n  name: broken_rel\n  from: account\n');
		expect(() =>
			loadProjectApiContext(root, null, {
				entitiesDir: path.join(root, 'entities'),
				junctionsDir: path.join(root, 'junctions'),
				relationshipsDir: path.join(root, 'relationships'),
			}),
		).toThrow('broken_rel.yaml');
	});
});
