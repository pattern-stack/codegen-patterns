/**
 * Tests for buildNounSummaryCommand() — verifies the generated Command class
 * loads context, calls the noun's summary/hints, and renders output.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Cli } from 'clipanion';
import { buildNounSummaryCommand, type NounModule } from '../../cli/noun-module.js';
import { setJsonMode } from '../../cli/ui/json.js';

function mkTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'nounmod-'));
}

const cleanup: string[] = [];

afterEach(() => {
	setJsonMode(false);
	for (const d of cleanup) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {}
	}
	cleanup.length = 0;
});

function buildFakeNoun(): NounModule {
	return {
		name: 'fake',
		commandClasses: [],
		async summary() {
			return {
				title: 'fake-title',
				body: ['line-one', 'line-two'],
				footer: 'fake-footer',
			};
		},
		async hints() {
			return [
				{ command: 'codegen fake new', description: 'create new' },
			];
		},
	};
}

describe('buildNounSummaryCommand', () => {
	test('generates a Command class with paths=[[nounName]]', () => {
		const Cls = buildNounSummaryCommand(buildFakeNoun()) as unknown as {
			paths: string[][];
			usage: { description: string };
		};
		expect(Cls.paths).toEqual([['fake']]);
		expect(Cls.usage.description).toContain('fake');
	});

	test('executes summary + hints and renders pane in text mode', async () => {
		const root = mkTempDir();
		cleanup.push(root);
		// Uninitialized project — skipDetection path isn't strictly required,
		// but the fake noun ignores ctx anyway.

		const noun = buildFakeNoun();
		const Cls = buildNounSummaryCommand(noun);

		const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
		cli.register(Cls);

		// Capture stdout to confirm rendering
		const chunks: string[] = [];
		const orig = console.log;
		console.log = (...a: unknown[]) => {
			chunks.push(a.map((x) => String(x)).join(' '));
		};
		try {
			const code = await cli.run(['fake', '--cwd', root]);
			expect(code).toBe(0);
		} finally {
			console.log = orig;
		}

		const output = chunks.join('\n');
		expect(output).toContain('fake-title');
		expect(output).toContain('line-one');
		expect(output).toContain('line-two');
		expect(output).toContain('fake-footer');
		expect(output).toContain('codegen fake new');
	});

	test('emits JSON when --json is set', async () => {
		const root = mkTempDir();
		cleanup.push(root);

		const noun = buildFakeNoun();
		const Cls = buildNounSummaryCommand(noun);

		const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
		cli.register(Cls);

		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((data: string | Uint8Array) => {
			chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
			return true;
		}) as typeof process.stdout.write;

		try {
			const code = await cli.run(['fake', '--json', '--cwd', root]);
			expect(code).toBe(0);
		} finally {
			process.stdout.write = original;
		}

		const parsed = JSON.parse(chunks.join(''));
		expect(parsed.noun).toBe('fake');
		expect(parsed.summary.title).toBe('fake-title');
		expect(parsed.hints).toHaveLength(1);
	});
});
