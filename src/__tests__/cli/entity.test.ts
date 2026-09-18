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

	// Silence intentional error-path CLI output (stderr + console.error) during
	// tests that assert exit codes for error cases. Assertions are unchanged;
	// this only suppresses the [FAIL] banner noise in test output.
	const origStderrWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (() => true) as typeof process.stderr.write;
	const origErr = console.error;
	console.error = () => {};

	return (async () => {
		try {
			const result = await fn();
			return { result, out: chunks.join('') };
		} finally {
			process.stdout.write = original;
			console.log = origLog;
			process.stderr.write = origStderrWrite;
			console.error = origErr;
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

	test('honors paths.events_dir for custom events source directory', async () => {
		const root = mkSelfContainedProject();
		tempDirs.push(root);
		// Overwrite config to point at a custom events dir and drop a
		// uniquely-named event YAML there. The generated `registry.ts` /
		// `types.ts` payload will reference the event type by name only if
		// codegen reads from the custom dir — so grepping JSON output for
		// the type name proves the resolver honored `paths.events_dir`.
		fs.writeFileSync(
			path.join(root, 'codegen.config.yaml'),
			'paths:\n  entities: entities\n  events_dir: custom-events\n',
		);
		fs.mkdirSync(path.join(root, 'custom-events'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'custom-events', 'marker_event_f4.yaml'),
			[
				'type: marker_event_f4',
				'direction: inbound',
				'source: test',
				'version: 1',
				'payload:',
				'  value:',
				'    type: string',
				'',
			].join('\n'),
		);
		const cli = buildCli();
		const { result, out } = await captureStdoutWrite(() =>
			cli.run([
				'entity',
				'new',
				path.join(root, 'entities', 'note.yaml'),
				'--dry-run',
				'--force',
				'--cwd',
				root,
				'--json',
			])
		);
		expect(result).toBe(0);
		expect(out).toContain('marker_event_f4');
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

	test('--all tolerates an invalid YAML alongside a valid one (default)', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		// Drop an invalid entity YAML (comments only, no `entity:` key) next to
		// the valid contact fixture — mirrors the scaffold's example.yaml that
		// originally triggered F12.
		fs.writeFileSync(
			path.join(root, 'entities', 'example.yaml'),
			'# this is a placeholder\n',
		);
		const cli = buildCli();
		const { result, out } = await captureStdoutWrite(() =>
			cli.run([
				'entity',
				'new',
				'--all',
				'--dry-run',
				'--force',
				'--json',
				'--cwd',
				root,
			]),
		);
		// The valid entity is still planned; the rejected one fails the run, as it
		// would a real run.
		expect(result).toBe(1);
		const parsed = JSON.parse(out);
		expect(parsed.command).toBe('entity new');
		expect(parsed.totals.planned).toBe(1);
		expect(parsed.totals.invalid).toBe(1);
		const names = (parsed.entities as Array<{ name: string }>).map((e) => e.name);
		expect(names).toContain('contact');
		expect(parsed.invalid).toHaveLength(1);
		expect(parsed.invalid[0].name).toBe('example.yaml');
		expect(parsed.invalid[0].message.length).toBeGreaterThan(0);
	});

	test('--all --no-continue-on-error restores fatal exit for invalid YAML', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		fs.writeFileSync(
			path.join(root, 'entities', 'example.yaml'),
			'# this is a placeholder\n',
		);
		const cli = buildCli();
		const { result } = await captureStdoutWrite(() =>
			cli.run([
				'entity',
				'new',
				'--all',
				'--dry-run',
				'--force',
				'--no-continue-on-error',
				'--cwd',
				root,
			]),
		);
		expect(result).toBe(1);
	});
});

/** Run the CLI capturing stdout and stderr separately (text mode). */
function captureStreams<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const decode = (d: string | Uint8Array) =>
		typeof d === 'string' ? d : new TextDecoder().decode(d);
	const origOut = process.stdout.write.bind(process.stdout);
	const origErrWrite = process.stderr.write.bind(process.stderr);
	const origLog = console.log;
	const origError = console.error;
	const origWarn = console.warn;
	process.stdout.write = ((d: string | Uint8Array) => {
		out.push(decode(d));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((d: string | Uint8Array) => {
		err.push(decode(d));
		return true;
	}) as typeof process.stderr.write;
	console.log = (...a: unknown[]) => void out.push(a.map(String).join(' ') + '\n');
	console.error = (...a: unknown[]) => void err.push(a.map(String).join(' ') + '\n');
	console.warn = (...a: unknown[]) => void err.push(a.map(String).join(' ') + '\n');
	return (async () => {
		try {
			const result = await fn();
			return { result, out: out.join(''), err: err.join('') };
		} finally {
			process.stdout.write = origOut;
			process.stderr.write = origErrWrite;
			console.log = origLog;
			console.error = origError;
			console.warn = origWarn;
		}
	})();
}

// #627: the reason a target was rejected is printed in every mode.
// `--continue-on-error` (the default) decides whether the run stops, never
// whether the reason is shown.
describe('entity noun — new reports every pre-flight rejection', () => {
	function mkInvalidProject(): string {
		const root = mkSelfContainedProject();
		tempDirs.push(root);
		// `config:` at the YAML root instead of inside `entity:` — the CAP-1 miss.
		fs.writeFileSync(
			path.join(root, 'entities', 'bad.yaml'),
			[
				'entity:',
				'  name: bad',
				'  plural: bads',
				'  table: bads',
				'config:',
				'  x: 1',
				'fields:',
				'  title:',
				'    type: string',
				'',
			].join('\n'),
		);
		return root;
	}

	test('default mode: one invalid YAML prints its reason and exits 1', async () => {
		const root = mkInvalidProject();
		const cli = buildCli();
		const { result, err } = await captureStreams(() =>
			cli.run([
				'entity',
				'new',
				path.join(root, 'entities', 'bad.yaml'),
				'--force',
				'--cwd',
				root,
			]),
		);
		expect(result).toBe(1);
		expect(err).toContain('bad.yaml');
		expect(err).toContain("'config'");
	});

	test('JSON mode: the rejection and its details are in the payload', async () => {
		const root = mkInvalidProject();
		const cli = buildCli();
		const { result, out } = await captureStreams(() =>
			cli.run([
				'entity',
				'new',
				path.join(root, 'entities', 'bad.yaml'),
				'--force',
				'--json',
				'--cwd',
				root,
			]),
		);
		expect(result).toBe(1);
		const parsed = JSON.parse(out);
		expect(parsed.totals.failed).toBe(1);
		expect(parsed.failed[0].name).toBe('bad.yaml');
		expect(parsed.failed[0].details.join('\n')).toContain("'config'");
	});

	test('--no-continue-on-error --json stops before generating and says why', async () => {
		const root = mkInvalidProject();
		const cli = buildCli();
		const { result, out } = await captureStreams(() =>
			cli.run([
				'entity',
				'new',
				'--all',
				'--force',
				'--json',
				'--no-continue-on-error',
				'--cwd',
				root,
			]),
		);
		expect(result).toBe(1);
		const parsed = JSON.parse(out);
		expect(parsed.stopped).toBe('pre-flight');
		expect(parsed.failed.map((f: { name: string }) => f.name)).toEqual(['bad.yaml']);
		expect(fs.existsSync(path.join(root, 'src'))).toBe(false);
	});

	test('an invalid emits: rejects the entity with its reason in default mode', async () => {
		const root = mkSelfContainedProject();
		tempDirs.push(root);
		fs.appendFileSync(
			path.join(root, 'entities', 'note.yaml'),
			'emits:\n  - no_such_event\n',
		);
		const cli = buildCli();
		const { result, err } = await captureStreams(() =>
			cli.run([
				'entity',
				'new',
				path.join(root, 'entities', 'note.yaml'),
				'--dry-run',
				'--force',
				'--cwd',
				root,
			]),
		);
		expect(result).toBe(1);
		expect(err).toContain('note.yaml — emits: validation failed');
		expect(err).toContain("emits 'no_such_event' has no matching");
	});

	test('an entity with emits: and roles: errors reports both', async () => {
		const root = mkSelfContainedProject();
		tempDirs.push(root);
		fs.appendFileSync(
			path.join(root, 'entities', 'note.yaml'),
			[
				'emits:',
				'  - no_such_event',
				'roles:',
				'  author:',
				'    target: nobody',
				'    cardinality: one',
				'',
			].join('\n'),
		);
		const cli = buildCli();
		const { result, out } = await captureStreams(() =>
			cli.run([
				'entity',
				'new',
				path.join(root, 'entities', 'note.yaml'),
				'--dry-run',
				'--force',
				'--json',
				'--cwd',
				root,
			]),
		);
		expect(result).toBe(1);
		const parsed = JSON.parse(out);
		expect(parsed.invalid).toHaveLength(1);
		expect(parsed.invalid[0].message).toBe('emits: and roles: validation failed');
		const details = parsed.invalid[0].details.join('\n');
		expect(details).toContain("emits 'no_such_event'");
		expect(details).toContain('nobody');
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
