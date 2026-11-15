/**
 * #915 — an entity YAML that fails the schema is a run-level rejection, named,
 * whichever command runs and whichever target it names. The whole-set
 * post-steps (barrels, relations manifest, scope union, events) read the
 * entity directory and used to skip an invalid entity without a word, writing a
 * manifest over a set missing it; the run then failed in `tsc`, far from the
 * cause. Nothing is written when the set is not whole.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cli } from 'clipanion';

import entityNoun from '../../cli/commands/entity.js';
import junctionNoun from '../../cli/commands/junction.js';
import relationshipNoun from '../../cli/commands/relationship.js';
import { setJsonMode } from '../../cli/ui/json.js';

const tempDirs: string[] = [];
afterEach(() => {
	setJsonMode(false);
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
	tempDirs.length = 0;
});

const NOTE = 'entity:\n  name: note\n  plural: notes\nfields:\n  body:\n    type: string\n';
const USER = 'entity:\n  name: user\n  plural: users\nfields:\n  email:\n    type: string\n';
// `config:` at the YAML root instead of inside `entity:` — fails the schema.
const BAD = 'entity:\n  name: bad\n  plural: bads\nconfig:\n  x: 1\nfields:\n  title:\n    type: string\n';

function mkProject(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'set-invalid-'));
	tempDirs.push(root);
	fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'paths:\n  entities: entities\n');
	fs.mkdirSync(path.join(root, 'entities'));
	fs.writeFileSync(path.join(root, 'entities', 'note.yaml'), NOTE);
	fs.writeFileSync(path.join(root, 'entities', 'user.yaml'), USER);
	fs.writeFileSync(path.join(root, 'entities', 'bad.yaml'), BAD);
	fs.mkdirSync(path.join(root, 'junctions'));
	fs.writeFileSync(
		path.join(root, 'junctions', 'note_user.yaml'),
		'pattern: Junction\nbetween: [note, user]\n',
	);
	fs.mkdirSync(path.join(root, 'relationships'));
	fs.writeFileSync(
		path.join(root, 'relationships', 'note_user_rel.yaml'),
		'relationship:\n  name: note_user_rel\n  from: note\n  to: user\n',
	);
	return root;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
	const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
	for (const noun of [entityNoun, junctionNoun, relationshipNoun]) {
		for (const Cls of noun.commandClasses) cli.register(Cls);
	}
	const chunks: string[] = [];
	const push = (...args: unknown[]) => chunks.push(args.map(String).join(' ') + '\n');
	const orig = {
		write: process.stdout.write.bind(process.stdout),
		ewrite: process.stderr.write.bind(process.stderr),
		log: console.log,
		warn: console.warn,
		error: console.error,
	};
	const sink = ((data: string | Uint8Array) => {
		chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
		return true;
	}) as typeof process.stdout.write;
	process.stdout.write = sink;
	process.stderr.write = sink;
	console.log = push;
	console.warn = push;
	console.error = push;
	try {
		return { code: await cli.run(argv), out: chunks.join('') };
	} finally {
		process.stdout.write = orig.write;
		process.stderr.write = orig.ewrite;
		console.log = orig.log;
		console.warn = orig.warn;
		console.error = orig.error;
	}
}

/** Hygen never ran and no whole-set file (barrels, manifest) was written. */
function expectNothingWritten(root: string): void {
	expect(fs.existsSync(path.join(root, 'src'))).toBe(false);
}

function expectNamesBad(out: string): void {
	expect(out).toContain('bad.yaml');
	expect(out).toContain("'config'");
}

describe('an invalid entity YAML is a named run-level rejection (#915)', () => {
	test('entity new --all', async () => {
		const root = mkProject();
		const { code, out } = await run(['entity', 'new', '--all', '--force', '--cwd', root]);
		expect(code).toBe(1);
		expectNamesBad(out);
		expectNothingWritten(root);
	});

	test('entity new <the invalid file>', async () => {
		const root = mkProject();
		const file = path.join(root, 'entities', 'bad.yaml');
		const { code, out } = await run(['entity', 'new', file, '--force', '--cwd', root]);
		expect(code).toBe(1);
		expectNamesBad(out);
		expectNothingWritten(root);
	});

	test('entity new <a different, valid entity> still stops on the invalid sibling', async () => {
		const root = mkProject();
		const file = path.join(root, 'entities', 'note.yaml');
		const { code, out } = await run(['entity', 'new', file, '--force', '--cwd', root]);
		expect(code).toBe(1);
		expectNamesBad(out);
		expectNothingWritten(root);
	});

	test('--json carries the rejection, stopped at pre-flight', async () => {
		const root = mkProject();
		const file = path.join(root, 'entities', 'note.yaml');
		const { code, out } = await run(['entity', 'new', file, '--force', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out);
		expect(payload.stopped).toBe('pre-flight');
		expect(payload.failed.map((f: { name: string }) => f.name)).toEqual(['bad.yaml']);
		expect(payload.failed[0].details.join('\n')).toContain("'config'");
		expectNothingWritten(root);
	});

	test('junction new stops on it too', async () => {
		const root = mkProject();
		const file = path.join(root, 'junctions', 'note_user.yaml');
		const { code, out } = await run(['junction', 'new', file, '--force', '--cwd', root]);
		expect(code).toBe(1);
		expectNamesBad(out);
		expectNothingWritten(root);
	});

	test('relationship new stops on it too', async () => {
		const root = mkProject();
		const file = path.join(root, 'relationships', 'note_user_rel.yaml');
		const { code, out } = await run(['relationship', 'new', file, '--force', '--cwd', root]);
		expect(code).toBe(1);
		expectNamesBad(out);
		expectNothingWritten(root);
	});
});
