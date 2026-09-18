/**
 * JOBS-2 (#664) — `entity new` rejects the run on an input every entity's
 * output depends on: an invalid `definitions/jobs/*.yaml`, or an app-pattern
 * file the loader cannot register. Each joins the CLI-0 (#627) rejection list —
 * printed in every mode, carried in `--json` — and stops the run before hygen
 * whatever `--continue-on-error` says (it is not one entity's problem). Nothing
 * is written: no barrel, no event / bridge registry, no orchestration barrel
 * from a partial pattern set. A stale `<type>.job.generated.ts` is left on disk
 * and named.
 */

import { afterEach, describe, expect, test } from 'bun:test';
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

const VALID_JOB = [
	'type: note_poll',
	'pool: integration',
	'triggers:',
	'  - schedule: { every: 15m, align: true }',
	'arms:',
	'  - kind: poll',
	'    domain: note',
	'    read:',
	'      mode: poll',
	'      poll:',
	'        cursor: { kind: timestamp, field: updated_at }',
	'      mapping:',
	'        - { source: id, target: external_id }',
	'',
].join('\n');

/** A package-mode project with one valid entity. */
function mkProject(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-reject-'));
	tempDirs.push(root);
	fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'paths:\n  entities: entities\n');
	fs.mkdirSync(path.join(root, 'entities'));
	fs.writeFileSync(path.join(root, 'entities', 'note.yaml'), VALID_ENTITY);
	return root;
}

function writeJob(root: string, name: string, body: string): string {
	const file = path.join(root, 'definitions/jobs', name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
	return file;
}

function writeBrokenPattern(root: string): string {
	const file = path.join(root, 'src/patterns/broken.pattern.ts');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "throw new Error('pattern file exploded at import');\nexport {};\n");
	return file;
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

const modulesBarrel = (root: string) => path.join(root, 'src/generated/modules.ts');
/** A file hygen writes for the `note` entity — absent means hygen never ran. */
const noteEntity = (root: string) => path.join(root, 'src/domain/note/note.entity.ts');

describe('entity new rejects the run on an invalid job YAML (#664)', () => {
	test('text mode — names the YAML and its reason, exit 1, nothing generated (default --continue-on-error)', async () => {
		const root = mkProject();
		writeJob(root, 'note_poll.yaml', VALID_JOB);
		writeJob(root, 'broken_poll.yaml', 'type: broken_poll\npool: 42\n');
		const { code, out } = await run(['entity', 'new', '--all', '--force', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain('broken_poll.yaml — ');
		expect(out).toContain("Expected string, received number at 'pool'");
		expect(out).not.toContain('generating note');
		expect(fs.existsSync(modulesBarrel(root))).toBe(false);
		expect(fs.existsSync(noteEntity(root))).toBe(false);
		expect(fs.existsSync(path.join(root, 'src/jobs/note_poll.job.generated.ts'))).toBe(false);
	});

	test('JSON mode — the rejection is in failed[], stopped at pre-flight', async () => {
		const root = mkProject();
		const file = writeJob(root, 'mismatch.yaml', VALID_JOB);
		const { code, out } = await run(['entity', 'new', '--all', '--force', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out);
		expect(payload).toMatchObject({
			command: 'entity new',
			stopped: 'pre-flight',
			totals: { succeeded: 0, failed: 1 },
			failed: [
				{
					name: 'mismatch.yaml',
					file,
					message: "Job file 'mismatch' must contain 'type: mismatch' (found 'type: note_poll')",
				},
			],
		});
		expect(fs.existsSync(modulesBarrel(root))).toBe(false);
		expect(fs.existsSync(noteEntity(root))).toBe(false);
	});

	test('a previously emitted base is left on disk and named as stale', async () => {
		const root = mkProject();
		writeJob(root, 'note_poll.yaml', 'type: note_poll\npool: 42\n');
		const stale = path.join(root, 'src/jobs/note_poll.job.generated.ts');
		fs.mkdirSync(path.dirname(stale), { recursive: true });
		fs.writeFileSync(stale, '// @generated — from the last valid note_poll.yaml\n');
		const { code, out } = await run(['entity', 'new', '--all', '--force', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const [rejection] = JSON.parse(out).failed;
		expect(fs.existsSync(noteEntity(root))).toBe(false);
		expect(rejection.details).toContain(
			`${stale} is stale: emitted from this job's last valid definition, it is left on disk until the YAML loads again`,
		);
		expect(fs.readFileSync(stale, 'utf-8')).toBe('// @generated — from the last valid note_poll.yaml\n');
	});

	test('a valid job — the run is unchanged: exit 0, handler base emitted', async () => {
		const root = mkProject();
		writeJob(root, 'note_poll.yaml', VALID_JOB);
		const { code, out } = await run(['entity', 'new', '--all', '--force', '--cwd', root]);
		expect(out).not.toContain('note_poll.yaml —');
		expect(code).toBe(0);
		expect(fs.existsSync(path.join(root, 'src/jobs/note_poll.job.generated.ts'))).toBe(true);
		expect(fs.existsSync(noteEntity(root))).toBe(true);
	}, 60_000);
});

describe('entity new rejects the run on an app-pattern file it cannot load (JOBS-2, from the #660 audit)', () => {
	test('text mode — names the file, exit 1, the orchestration barrel is not rewritten', async () => {
		const root = mkProject();
		writeBrokenPattern(root);
		const barrel = path.join(root, 'src/orchestration/index.ts');
		fs.mkdirSync(path.dirname(barrel), { recursive: true });
		fs.writeFileSync(barrel, '// previous orchestration barrel\n');
		const { code, out } = await run(['entity', 'new', '--all', '--force', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain('broken.pattern.ts — app pattern file could not be loaded');
		expect(out).toContain('pattern file exploded at import');
		expect(fs.readFileSync(barrel, 'utf-8')).toBe('// previous orchestration barrel\n');
		expect(fs.existsSync(modulesBarrel(root))).toBe(false);
		expect(fs.existsSync(noteEntity(root))).toBe(false);
	});

	test('JSON mode — the rejection is in failed[]', async () => {
		const root = mkProject();
		const file = writeBrokenPattern(root);
		const { code, out } = await run(['entity', 'new', '--all', '--force', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out);
		expect(payload).toMatchObject({
			command: 'entity new',
			stopped: 'pre-flight',
			failed: [{ name: 'broken.pattern.ts', file, message: 'app pattern file could not be loaded' }],
		});
		expect(payload.failed[0].details[0]).toContain('pattern file exploded at import');
		expect(fs.existsSync(noteEntity(root))).toBe(false);
	});
});
