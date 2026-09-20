/**
 * The CLI-spawn helper (STUDIO-0, #698).
 *
 * The server never reimplements generation: every generator operation is the
 * real CLI, spawned and parsed here. The case that matters most is a non-zero
 * exit with NO payload — if that were papered over as `{}`, a failed generate
 * would report success to the browser.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	parseCliJson,
	resetCliEntryCache,
	resolveCliEntry,
	runCliJson,
	streamCommand,
} from '../../studio/server/cli-runner';

const ORIGINAL = process.env.CODEGEN_STUDIO_CLI;

afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.CODEGEN_STUDIO_CLI;
	else process.env.CODEGEN_STUDIO_CLI = ORIGINAL;
	resetCliEntryCache();
});

/** Write a stub "CLI" and point the runner at it. */
function stubCli(body: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-'));
	const file = path.join(dir, 'stub.ts');
	fs.writeFileSync(file, body);
	process.env.CODEGEN_STUDIO_CLI = `bun ${file}`;
	resetCliEntryCache();
	return dir;
}

describe('parseCliJson', () => {
	it('parses a pure JSON payload', () => {
		expect(parseCliJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
	});

	it('parses a pretty-printed payload', () => {
		expect(parseCliJson<{ command: string }>('{\n  "command": "entity validate"\n}')).toEqual({
			command: 'entity validate',
		});
	});

	it('skips a warning line printed before the payload', () => {
		const out = 'WARN something unrelated\n{"valid":true}\n';
		expect(parseCliJson<{ valid: boolean }>(out)).toEqual({ valid: true });
	});

	it('ignores trailing noise after the payload', () => {
		expect(parseCliJson<{ ok: boolean }>('{"ok":true}\ndone.\n')).toEqual({ ok: true });
	});

	it('is not fooled by a brace inside a string', () => {
		const out = 'note: use {like this}\n{"a":"}"}\n';
		expect(parseCliJson<{ a: string }>(out)).toEqual({ a: '}' });
	});

	it('returns null — never {} — when there is no payload at all', () => {
		expect(parseCliJson('boom: command not found\n')).toBeNull();
	});

	it('returns null for empty output', () => {
		expect(parseCliJson('')).toBeNull();
	});
});

describe('resolveCliEntry', () => {
	it('honours the CODEGEN_STUDIO_CLI override', () => {
		process.env.CODEGEN_STUDIO_CLI = 'bun /tmp/x/cli.ts';
		resetCliEntryCache();
		expect(resolveCliEntry()).toEqual({ command: 'bun', args: ['/tmp/x/cli.ts'] });
	});

	it('finds this repo’s own dev entry when unset', () => {
		delete process.env.CODEGEN_STUDIO_CLI;
		resetCliEntryCache();
		const entry = resolveCliEntry();
		expect(entry.command).toBe('bun');
		expect(entry.args[0].endsWith(path.join('src', 'cli', 'index.ts'))).toBe(true);
		expect(fs.existsSync(entry.args[0])).toBe(true);
	});
});

describe('runCliJson', () => {
	it('returns ok with the parsed payload on a clean exit', async () => {
		const dir = stubCli(`console.log(JSON.stringify({ command: 'stub', entities: 3 }));`);
		const res = await runCliJson<{ entities: number }>(['project', 'graph'], { cwd: dir });
		expect(res.ok).toBe(true);
		expect(res.exitCode).toBe(0);
		expect(res.payload).toEqual({ command: 'stub', entities: 3 });
	});

	it('appends --json when the caller did not', async () => {
		const dir = stubCli(`console.log(JSON.stringify({ argv: process.argv.slice(2) }));`);
		const res = await runCliJson<{ argv: string[] }>(['entity', 'validate'], { cwd: dir });
		expect(res.payload?.argv).toEqual(['entity', 'validate', '--json']);
	});

	it('does not append --json twice', async () => {
		const dir = stubCli(`console.log(JSON.stringify({ argv: process.argv.slice(2) }));`);
		const res = await runCliJson<{ argv: string[] }>(['entity', 'validate', '--json'], {
			cwd: dir,
		});
		expect(res.payload?.argv).toEqual(['entity', 'validate', '--json']);
	});

	it('keeps the payload of a non-zero exit that still printed one', async () => {
		// `entity validate` exits 1 when the project has errors — a real answer.
		const dir = stubCli(
			`console.log(JSON.stringify({ valid: false, errors: [{ message: 'bad' }] }));\nprocess.exit(1);`,
		);
		const res = await runCliJson<{ valid: boolean }>(['entity', 'validate'], { cwd: dir });
		expect(res.exitCode).toBe(1);
		expect(res.payload).toEqual({ valid: false, errors: [{ message: 'bad' }] });
		// ok tracks "exited clean AND parsed" — callers that accept a non-zero
		// exit read `payload`, not `ok`.
		expect(res.ok).toBe(false);
	});

	it('reports a NON-ZERO EXIT WITH NO PAYLOAD as a failure, not as empty data', async () => {
		const dir = stubCli(`console.error('CodegenConfigError: unknown key');\nprocess.exit(1);`);
		const res = await runCliJson(['project', 'graph'], { cwd: dir });
		expect(res.ok).toBe(false);
		expect(res.exitCode).toBe(1);
		expect(res.payload).toBeNull();
		expect(res.stderr).toContain('unknown key');
	});

	it('reports a CLI that cannot be spawned at all', async () => {
		process.env.CODEGEN_STUDIO_CLI = '/definitely/not/a/binary';
		resetCliEntryCache();
		const res = await runCliJson(['project', 'graph'], { cwd: os.tmpdir() });
		expect(res.ok).toBe(false);
		expect(res.payload).toBeNull();
		expect(res.exitCode).toBeNull();
	});
});

describe('streamCommand', () => {
	it('delivers complete lines as they arrive', async () => {
		const lines: string[] = [];
		const res = await streamCommand(
			'bun',
			['-e', `console.log('one'); console.log('two'); console.log('three');`],
			{ cwd: os.tmpdir() },
			(l) => lines.push(l),
		);
		expect(res.exitCode).toBe(0);
		expect(lines).toEqual(['one', 'two', 'three']);
	});

	it('flushes a trailing line that has no newline', async () => {
		const lines: string[] = [];
		await streamCommand(
			'bun',
			['-e', `process.stdout.write('no-newline')`],
			{ cwd: os.tmpdir() },
			(l) => lines.push(l),
		);
		expect(lines).toEqual(['no-newline']);
	});

	it('does not splice a partial stdout line onto a stderr line', async () => {
		const lines: string[] = [];
		await streamCommand(
			'bun',
			['-e', `process.stdout.write('out-partial'); process.stderr.write('err-partial');`],
			{ cwd: os.tmpdir() },
			(l) => lines.push(l),
		);
		expect(lines.sort()).toEqual(['err-partial', 'out-partial']);
	});

	it('surfaces a spawn failure rather than a fake exit code', async () => {
		const res = await streamCommand(
			'/definitely/not/a/binary',
			[],
			{ cwd: os.tmpdir() },
			() => {},
		);
		expect(res.exitCode).toBeNull();
		expect(res.error).toBeTruthy();
	});
});
