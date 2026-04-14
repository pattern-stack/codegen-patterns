/**
 * Tests for the entity noun — summary, list, validate, dry-run new.
 *
 * Integration-level: these drive the Clipanion Cli with a temp project
 * rooted at test/fixtures so we don't touch the user's cwd.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Cli } from 'clipanion';

import entityNoun, {
	EntityNewCommand,
	EntityListCommand,
	EntityValidateCommand,
} from '../../cli/commands/entity.js';
import { buildNounSummaryCommand } from '../../cli/noun-module.js';
import { setJsonMode } from '../../cli/ui/json.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CONTACT_FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'contact-v2.yaml');

function mkTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-cli-'));
	fs.mkdirSync(path.join(dir, 'entities'), { recursive: true });
	fs.copyFileSync(CONTACT_FIXTURE, path.join(dir, 'entities', 'contact.yaml'));
	fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), 'paths:\n  entities: entities\n');
	return dir;
}

/** Project with a self-contained entity (no unresolved cross-refs). */
function mkSelfContainedProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-self-'));
	fs.mkdirSync(path.join(dir, 'entities'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'entities', 'note.yaml'),
		[
			'entity:',
			'  name: note',
			'  plural: notes',
			'  table: notes',
			'fields:',
			'  id:',
			'    type: uuid',
			'    required: true',
			'  title:',
			'    type: string',
			'    required: true',
			'    max_length: 200',
			'',
		].join('\n')
	);
	fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), 'paths:\n  entities: entities\n');
	return dir;
}

const tempDirs: string[] = [];

afterEach(() => {
	setJsonMode(false);
	for (const d of tempDirs) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {}
	}
	tempDirs.length = 0;
});

function buildCli() {
	const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
	for (const Cls of entityNoun.commandClasses) cli.register(Cls);
	cli.register(buildNounSummaryCommand(entityNoun));
	return cli;
}

function captureStdoutWrite<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((data: string | Uint8Array) => {
		chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
		return true;
	}) as typeof process.stdout.write;

	const origLog = console.log;
	console.log = (...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' ') + '\n');
	};

	return (async () => {
		try {
			const result = await fn();
			return { result, out: chunks.join('') };
		} finally {
			process.stdout.write = original;
			console.log = origLog;
		}
	})();
}

describe('entity noun — summary', () => {
	test('renders pane listing fixture contact entity', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result, out } = await captureStdoutWrite(() => cli.run(['entity', '--cwd', root]));
		expect(result).toBe(0);
		expect(out).toContain('entities');
		expect(out).toContain('contact');
	});

	test('JSON output includes noun + summary + hints', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { out } = await captureStdoutWrite(() =>
			cli.run(['entity', '--cwd', root, '--json'])
		);
		const parsed = JSON.parse(out);
		expect(parsed.noun).toBe('entity');
		expect(parsed.summary.title).toBe('entities');
		expect(Array.isArray(parsed.hints)).toBe(true);
	});

	test('summary is directly callable and reports counts', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const { loadContext } = await import('../../cli/shared/context.js');
		const ctx = await loadContext({ cwd: root, skipDetection: true });
		const pane = await entityNoun.summary(ctx);
		expect(pane.footer).toContain('1 entities');
	});
});

describe('entity noun — validate', () => {
	test('passes for a self-contained entity set', async () => {
		const root = mkSelfContainedProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await captureStdoutWrite(() =>
			cli.run(['entity', 'validate', '--cwd', root])
		);
		expect(result).toBe(0);
	});

	test('fails when cross-refs are missing', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await captureStdoutWrite(() =>
			cli.run(['entity', 'validate', '--cwd', root])
		);
		expect(result).toBe(1);
	});

	test('fails when directory does not exist', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-invalid-'));
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await captureStdoutWrite(() =>
			cli.run(['entity', 'validate', 'missing-dir', '--cwd', root])
		);
		expect(result).toBe(1);
	});
});

describe('entity noun — list', () => {
	test('prints table with the fixture entity', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result, out } = await captureStdoutWrite(() =>
			cli.run(['entity', 'list', '--cwd', root])
		);
		expect(result).toBe(0);
		expect(out).toContain('NAME');
		expect(out).toContain('contact');
	});

	test('json format emits structured payload', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { out } = await captureStdoutWrite(() =>
			cli.run(['entity', 'list', '--format', 'json', '--cwd', root])
		);
		const parsed = JSON.parse(out);
		expect(parsed.command).toBe('entity list');
		expect(parsed.entities[0].name).toBe('contact');
	});
});

describe('entity noun — new --dry-run', () => {
	test('reports plan without invoking hygen', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result, out } = await captureStdoutWrite(() =>
			cli.run([
				'entity',
				'new',
				path.join(root, 'entities', 'contact.yaml'),
				'--dry-run',
				'--force',
				'--cwd',
				root,
			])
		);
		expect(result).toBe(0);
		expect(out).toContain('Dry run');
		expect(out).toContain('contact');
	});

	test('rejects both --all and positional yaml', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await captureStdoutWrite(() =>
			cli.run([
				'entity',
				'new',
				path.join(root, 'entities', 'contact.yaml'),
				'--all',
				'--cwd',
				root,
			])
		);
		expect(result).toBe(2);
	});

	test('fails when no yaml and no --all', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await captureStdoutWrite(() =>
			cli.run(['entity', 'new', '--cwd', root])
		);
		expect(result).toBe(2);
	});
});

describe('entity noun — module shape', () => {
	test('exports canonical command classes', () => {
		expect(entityNoun.name).toBe('entity');
		expect(entityNoun.commandClasses).toContain(EntityNewCommand);
		expect(entityNoun.commandClasses).toContain(EntityListCommand);
		expect(entityNoun.commandClasses).toContain(EntityValidateCommand);
	});
});
