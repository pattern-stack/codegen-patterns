/**
 * #813 — a reserved entity name is visible through `entity validate`.
 * In-process Clipanion, same harness shape as pattern-load-errors.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cli } from 'clipanion';
import type { CommandClass } from 'clipanion';

import entityNoun from '../../cli/commands/entity.js';
import { setJsonMode } from '../../cli/ui/json.js';

const tempDirs: string[] = [];

afterEach(() => {
	setJsonMode(false);
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
	tempDirs.length = 0;
});

function mkProject(name: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reserved-name-'));
	tempDirs.push(root);
	fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'paths:\n  entities: entities\n');
	fs.mkdirSync(path.join(root, 'entities'));
	fs.writeFileSync(
		path.join(root, 'entities', `${name}.yaml`),
		`entity:\n  name: ${name}\n  plural: ${name}s\nfields:\n  body:\n    type: string\n`,
	);
	return root;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
	const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
	for (const Cls of entityNoun.commandClasses as CommandClass[]) cli.register(Cls);
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

describe('entity validate rejects a reserved entity name (#813)', () => {
	test('--json — exit 1, one error naming the entity and the global', async () => {
		const root = mkProject('date');
		const { code, out } = await run(['entity', 'validate', '--json', '--cwd', root]);
		expect(code).toBe(1);
		const payload = JSON.parse(out);
		expect(payload.valid).toBe(false);
		// The loader reports a header entry and then one entry per Zod issue.
		const reserved = payload.errors.filter((e: { message: string }) => e.message.includes('is reserved'));
		expect(reserved).toHaveLength(1);
		expect(reserved[0].message).toContain("'date'");
		expect(reserved[0].message).toContain('Date');
	});

	test('text mode — printed as a validation error, exit 1', async () => {
		const root = mkProject('date');
		const { code, out } = await run(['entity', 'validate', '--cwd', root]);
		expect(code).toBe(1);
		expect(out).toContain('validation errors');
		expect(out).toContain("Entity name 'date' is reserved");
		expect(out).not.toContain('All entities validated');
	});

	test('a name that merely looks like a global validates', async () => {
		const root = mkProject('record');
		const { code } = await run(['entity', 'validate', '--cwd', root]);
		expect(code).toBe(0);
	});
});
