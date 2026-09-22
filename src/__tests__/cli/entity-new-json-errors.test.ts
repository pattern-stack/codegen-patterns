/**
 * CLI-1 (#669) — every `entity new` stop before a target is considered prints a
 * payload under `--json`: `{ command: 'entity new', status: 'error', error }`,
 * with the exit code the text-mode run gives. Before, `printError` (a no-op in
 * JSON mode) left stdout empty. From the #670 review: a dirty generated-output
 * tree without `--force` fell through under `--json` and generated anyway; it
 * now stops with the payload and writes nothing.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cli } from 'clipanion';

import entityNoun from '../../cli/commands/entity.js';
import { setJsonMode } from '../../cli/ui/json.js';

const tempDirs: string[] = [];

afterEach(() => {
	setJsonMode(false);
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
	tempDirs.length = 0;
});

const VALID_ENTITY =
	'entity:\n  name: note\n  plural: notes\n  table: notes\nfields:\n  body:\n    type: string\n';

/** A package-mode project; `withEntity` adds `entities/note.yaml`. */
function mkProject(withEntity: boolean): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-new-json-'));
	tempDirs.push(root);
	fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'paths:\n  entities: entities\n');
	fs.mkdirSync(path.join(root, 'entities'));
	if (withEntity) fs.writeFileSync(path.join(root, 'entities', 'note.yaml'), VALID_ENTITY);
	return root;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
	const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
	for (const Cls of entityNoun.commandClasses) cli.register(Cls);
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

describe('entity new --json — early returns carry a payload (#669)', () => {
	test('--all with no entity YAML: exit 1, the error in the payload', async () => {
		const root = mkProject(false);
		const { code, out } = await run(['entity', 'new', '--all', '--json', '--cwd', root]);
		expect(code).toBe(1);
		expect(JSON.parse(out)).toEqual({
			command: 'entity new',
			status: 'error',
			error: `No entity YAML files found in ${path.join(root, 'entities')}`,
		});
	});

	test('--all plus a path: exit 2, the usage error in the payload', async () => {
		const root = mkProject(true);
		const { code, out } = await run([
			'entity', 'new', 'entities/note.yaml', '--all', '--json', '--cwd', root,
		]);
		expect(code).toBe(2);
		expect(JSON.parse(out)).toEqual({
			command: 'entity new',
			status: 'error',
			error: 'Pass either a YAML path or --all, not both.',
		});
	});

	test('neither a path nor --all: exit 2, the usage error in the payload', async () => {
		const root = mkProject(true);
		const { code, out } = await run(['entity', 'new', '--json', '--cwd', root]);
		expect(code).toBe(2);
		expect(JSON.parse(out)).toEqual({
			command: 'entity new',
			status: 'error',
			error: 'Missing YAML path. Pass a file or --all.',
		});
	});

	test('text mode is unchanged: the message printed, same exit code', async () => {
		const root = mkProject(false);
		const { code, out } = await run(['entity', 'new', '--all', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain(`No entity YAML files found in ${path.join(root, 'entities')}`);
		expect(out).not.toContain('"status"');
	});
});

describe('entity new — a dirty generated-output tree without --force (#670 review)', () => {
	/** The project as a git repo with a committed, then edited, generated barrel. */
	function dirtyRepo(): { root: string; barrel: string } {
		const root = mkProject(true);
		const barrel = path.join(root, 'src/generated/modules.ts');
		fs.mkdirSync(path.dirname(barrel), { recursive: true });
		fs.writeFileSync(barrel, '// committed\n');
		const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, stdio: 'ignore' });
		git('init -q');
		git('config user.email t@t');
		git('config user.name t');
		git('add -A');
		git('commit -q -m init');
		fs.writeFileSync(barrel, '// hand edit\n');
		return { root, barrel };
	}

	test('--json: exit 1 with the payload, nothing generated, the edit kept', async () => {
		const { root, barrel } = dirtyRepo();
		const { code, out } = await run(['entity', 'new', '--all', '--json', '--cwd', root]);
		expect(code).toBe(1);
		expect(JSON.parse(out)).toEqual({
			command: 'entity new',
			status: 'error',
			error: 'Uncommitted changes in 1 generated-output files. Pass --force to overwrite.',
		});
		expect(fs.readFileSync(barrel, 'utf-8')).toBe('// hand edit\n');
		expect(fs.existsSync(path.join(root, 'src/domain/note/note.entity.ts'))).toBe(false);
	});

	test('text mode: exit 1 with the warning, as before', async () => {
		const { root, barrel } = dirtyRepo();
		const { code, out } = await run(['entity', 'new', '--all', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain('Uncommitted changes in 1 generated-output files. Pass --force to overwrite.');
		expect(fs.readFileSync(barrel, 'utf-8')).toBe('// hand edit\n');
	});
});
