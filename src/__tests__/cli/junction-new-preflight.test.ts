/**
 * JUNC-0 (#678) — `junction new` pre-flights before writing anything.
 *
 * - A target outside `junctions/` is rejected: both parents render a junction's
 *   fan-out from the YAMLs under `junctions/`, so an outside file would get its
 *   own files but no fan-out — silently half-wired.
 * - Each problem is reported once: a junction naming an entity with no YAML
 *   (the entity pre-flight's junction-set check), and a target that fails its
 *   own load (the per-target entry; the junction-set check's duplicate for the
 *   same file is dropped).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cli } from 'clipanion';

import junctionNoun from '../../cli/commands/junction.js';
import { setJsonMode } from '../../cli/ui/json.js';

const tempDirs: string[] = [];
afterEach(() => {
	setJsonMode(false);
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
	tempDirs.length = 0;
});

const NOTE = 'entity:\n  name: note\n  plural: notes\n  table: notes\nfields:\n  body:\n    type: string\n';
const USER = 'entity:\n  name: user\n  plural: users\n  table: users\nfields:\n  email:\n    type: string\n';

function mkProject(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-preflight-'));
	tempDirs.push(root);
	fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'paths:\n  entities: entities\n');
	fs.mkdirSync(path.join(root, 'entities'));
	fs.writeFileSync(path.join(root, 'entities', 'note.yaml'), NOTE);
	fs.writeFileSync(path.join(root, 'entities', 'user.yaml'), USER);
	fs.mkdirSync(path.join(root, 'junctions'));
	return root;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
	const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
	for (const Cls of junctionNoun.commandClasses) cli.register(Cls);
	const chunks: string[] = [];
	const push = (...args: unknown[]) => chunks.push(args.map(String).join(' ') + '\n');
	const orig = { write: process.stdout.write.bind(process.stdout), log: console.log, warn: console.warn, error: console.error };
	process.stdout.write = ((data: string | Uint8Array) => {
		chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
		return true;
	}) as typeof process.stdout.write;
	console.log = push;
	console.warn = push;
	console.error = push;
	try {
		return { code: await cli.run(argv), out: chunks.join('') };
	} finally {
		process.stdout.write = orig.write;
		console.log = orig.log;
		console.warn = orig.warn;
		console.error = orig.error;
	}
}

const generatedAnything = (root: string) => fs.existsSync(path.join(root, 'src'));

describe('junction new pre-flight (JUNC-0)', () => {
	test('a target outside junctions/ is rejected, nothing generated', async () => {
		const root = mkProject();
		const outside = path.join(root, 'elsewhere', 'note_user.yaml');
		fs.mkdirSync(path.dirname(outside));
		fs.writeFileSync(outside, 'pattern: Junction\nbetween: [note, user]\n');
		const { code, out } = await run(['junction', 'new', outside, '--force', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain('note_user.yaml — not under junctions/');
		expect(generatedAnything(root)).toBe(false);
	});

	test('a junction naming an entity with no YAML is reported once', async () => {
		const root = mkProject();
		fs.writeFileSync(path.join(root, 'junctions', 'note_ghost.yaml'), 'pattern: Junction\nbetween: [note, ghost]\n');
		const { code, out } = await run(['junction', 'new', '--all', '--force', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out.slice(out.indexOf('{')));
		expect(payload.stopped).toBe('pre-flight');
		const mentions = payload.failed.filter((f: { message: string }) => f.message.includes("'ghost'"));
		expect(mentions).toHaveLength(1);
		expect(generatedAnything(root)).toBe(false);
	});

	test('a target that fails its own load is reported once, in both modes', async () => {
		const root = mkProject();
		const file = path.join(root, 'junctions', 'note_note.yaml');
		fs.writeFileSync(file, 'pattern: Junction\nbetween: [note, note]\n');
		const { code, out } = await run(['junction', 'new', file, '--force', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out.slice(out.indexOf('{')));
		expect(payload.stopped).toBe('pre-flight');
		expect(payload.failed.filter((f: { file: string }) => f.file === file)).toHaveLength(1);
		expect(generatedAnything(root)).toBe(false);
	});
});
