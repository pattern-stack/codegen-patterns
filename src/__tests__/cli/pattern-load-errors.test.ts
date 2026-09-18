/**
 * CLI-1 (#667) — an app-pattern file the loader cannot register is never a
 * text-only warning. `orchestration gen` writes from the pattern set, so it
 * stops before writing (the JOBS-2 run rejection: printed in every mode, `--json`
 * `stopped: 'pre-flight'`, exit 1). The validators read against the set, so each
 * loader error is an error-severity finding: printed with the other errors,
 * carried in `--json`, and the command's error rule (exit 1) applies.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cli } from 'clipanion';
import type { CommandClass } from 'clipanion';

import entityNoun from '../../cli/commands/entity.js';
import orchestrationNoun from '../../cli/commands/orchestration.js';
import projectNoun from '../../cli/commands/project.js';
import { setJsonMode } from '../../cli/ui/json.js';

const tempDirs: string[] = [];

afterEach(() => {
	setJsonMode(false);
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
	tempDirs.length = 0;
});

const VALID_ENTITY =
	'entity:\n  name: note\n  plural: notes\n  table: notes\nfields:\n  body:\n    type: string\n';

/** A project with one valid entity and a pattern file that throws at import. */
function mkProject(): { root: string; broken: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-load-'));
	tempDirs.push(root);
	fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'paths:\n  entities: entities\n');
	fs.mkdirSync(path.join(root, 'entities'));
	fs.writeFileSync(path.join(root, 'entities', 'note.yaml'), VALID_ENTITY);
	const broken = path.join(root, 'src/patterns/broken.pattern.ts');
	fs.mkdirSync(path.dirname(broken), { recursive: true });
	fs.writeFileSync(broken, "throw new Error('pattern file exploded at import');\nexport {};\n");
	return { root, broken };
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
	const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
	for (const noun of [entityNoun, orchestrationNoun, projectNoun]) {
		for (const Cls of noun.commandClasses as CommandClass[]) cli.register(Cls);
	}
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

describe('orchestration gen stops on a pattern file it cannot load (#667)', () => {
	test('text mode — names the file, exit 1, the root barrel is not rewritten', async () => {
		const { root } = mkProject();
		const barrel = path.join(root, 'src/orchestration/index.ts');
		fs.mkdirSync(path.dirname(barrel), { recursive: true });
		fs.writeFileSync(barrel, '// previous orchestration barrel\n');
		const { code, out } = await run(['orchestration', 'gen', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain('broken.pattern.ts — app pattern file could not be loaded');
		expect(out).toContain('pattern file exploded at import');
		expect(fs.readFileSync(barrel, 'utf-8')).toBe('// previous orchestration barrel\n');
	});

	test('JSON mode — the rejection is in failed[], stopped at pre-flight', async () => {
		const { root, broken } = mkProject();
		const { code, out } = await run(['orchestration', 'gen', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out);
		expect(payload).toMatchObject({
			command: 'orchestration gen',
			stopped: 'pre-flight',
			totals: { succeeded: 0, failed: 1 },
			failed: [{ name: 'broken.pattern.ts', file: broken, message: 'app pattern file could not be loaded' }],
		});
		expect(payload.failed[0].details[0]).toContain('pattern file exploded at import');
		expect(fs.existsSync(path.join(root, 'src/orchestration/index.ts'))).toBe(false);
	});
});

describe('the validators report a pattern file they cannot load as an error (#667)', () => {
	test('entity validate --json — exit 1, the error in errors[]', async () => {
		const { root, broken } = mkProject();
		const { code, out } = await run(['entity', 'validate', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out);
		expect(payload.valid).toBe(false);
		expect(payload.errors).toHaveLength(1);
		expect(payload.errors[0].path).toBe(broken);
		expect(payload.errors[0].message).toContain('pattern file exploded at import');
	});

	test('entity validate, text mode — printed as a validation error, exit 1', async () => {
		const { root, broken } = mkProject();
		const { code, out } = await run(['entity', 'validate', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain('1 validation errors');
		expect(out).toContain(broken);
		expect(out).not.toContain('All entities validated');
	});

	test('project inspect --kind analyze --json — exit 1, the issue in issues[]', async () => {
		const { root, broken } = mkProject();
		const { code, out } = await run(['project', 'inspect', '--kind', 'analyze', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out);
		expect(payload.isValid).toBe(false);
		expect(payload.summary.errors).toBe(1);
		expect(payload.issues).toContainEqual(
			expect.objectContaining({ severity: 'error', type: 'app_pattern_load_failed', path: broken }),
		);
	});

	test('project inspect --kind stats --format json — exit 1, counted in issueCount.errors', async () => {
		const { root } = mkProject();
		const { code, out } = await run([
			'project', 'inspect', '--kind', 'stats', '--format', 'json', '--cwd', root,
		]);
		expect(code).toBe(1);
		const payload = JSON.parse(out);
		expect(payload.isValid).toBe(false);
		expect(payload.issueCount.errors).toBe(1);
	});
});
