/**
 * Tests for the subsystem noun — summary, install (dry-run + real), list,
 * remove stub. Uses a temp fixture project as the install target so we
 * never touch the user's actual cwd.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Cli } from 'clipanion';

import subsystemNoun from '../../cli/commands/subsystem.js';
import { buildNounSummaryCommand } from '../../cli/noun-module.js';
import { setJsonMode } from '../../cli/ui/json.js';
import {
	detectInstalledSubsystems,
	SUBSYSTEMS,
} from '../../cli/shared/subsystem-detect.js';
import { copyRuntime } from '../../cli/shared/runtime-copier.js';
import { loadContext } from '../../cli/shared/context.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const RUNTIME_ROOT = path.join(REPO_ROOT, 'runtime');

function mkTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subsystem-cli-'));
	fs.writeFileSync(
		path.join(dir, 'codegen.config.yaml'),
		'paths:\n  subsystems: src/shared/subsystems\n'
	);
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
	for (const Cls of subsystemNoun.commandClasses) cli.register(Cls);
	cli.register(buildNounSummaryCommand(subsystemNoun));
	return cli;
}

function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((data: string | Uint8Array) => {
		chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
		return true;
	}) as typeof process.stdout.write;

	const origLog = console.log;
	const origWarn = console.warn;
	const origErr = console.error;
	console.log = (...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' ') + '\n');
	};
	console.warn = (...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' ') + '\n');
	};
	console.error = (...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' ') + '\n');
	};

	return (async () => {
		try {
			const result = await fn();
			return { result, out: chunks.join('') };
		} finally {
			process.stdout.write = original;
			console.log = origLog;
			console.warn = origWarn;
			console.error = origErr;
		}
	})();
}

// ---------------------------------------------------------------------------

describe('subsystem — descriptor', () => {
	test('knows all four subsystems', () => {
		expect(SUBSYSTEMS.map((s) => s.name).sort()).toEqual(
			['cache', 'events', 'jobs', 'storage'].sort()
		);
	});
});

describe('subsystem — summary + list', () => {
	test('summary on a fresh project reports 0 installed', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result, out } = await capture(() => cli.run(['subsystem', '--cwd', root]));
		expect(result).toBe(0);
		expect(out).toContain('subsystems');
		expect(out).toContain('No subsystems installed yet.');
	});

	test('list --format json emits structured rows', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { out } = await capture(() =>
			cli.run(['subsystem', 'list', '--format', 'json', '--cwd', root])
		);
		const parsed = JSON.parse(out);
		expect(parsed.command).toBe('subsystem list');
		expect(parsed.subsystems).toHaveLength(4);
		for (const row of parsed.subsystems) {
			expect(row.status).toBe('available');
		}
	});
});

describe('subsystem — install (dry-run)', () => {
	test('reports planned files without touching disk', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result, out } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'events',
				'--dry-run',
				'--force',
				'--json',
				'--cwd',
				root,
			])
		);
		expect(result).toBe(0);
		const parsed = JSON.parse(out);
		expect(parsed.subsystem).toBe('events');
		expect(parsed.dryRun).toBe(true);
		expect(parsed.files.planned.length).toBeGreaterThan(0);
		// nothing should have been written
		expect(fs.existsSync(path.join(root, 'src/shared/subsystems/events'))).toBe(false);
	});

	test('rejects unknown subsystem name', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await capture(() =>
			cli.run(['subsystem', 'install', 'unknown-thing', '--cwd', root])
		);
		expect(result).toBe(2);
	});

	test('rejects invalid --backend for subsystem', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--backend', 'local', '--cwd', root])
		);
		expect(result).toBe(2);
	});
});

describe('subsystem — install (real)', () => {
	test('copies runtime/subsystems/events into target + follows deps', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'events',
				'--force',
				'--json',
				'--cwd',
				root,
			])
		);
		expect(result).toBe(0);
		const installDir = path.join(root, 'src/shared/subsystems/events');
		expect(fs.existsSync(installDir)).toBe(true);
		// Core files present
		expect(fs.existsSync(path.join(installDir, 'events.module.ts'))).toBe(true);
		expect(fs.existsSync(path.join(installDir, 'event-bus.protocol.ts'))).toBe(true);
		// Dependencies (runtime/types/drizzle.ts) copied to parallel tree
		expect(fs.existsSync(path.join(root, 'src/shared/types/drizzle.ts'))).toBe(true);
		expect(fs.existsSync(path.join(root, 'src/shared/constants/tokens.ts'))).toBe(true);
	});

	test('memory backend skips .drizzle-backend.ts; schema is still emitted via Hygen', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'events',
				'--backend',
				'memory',
				'--force',
				'--json',
				'--cwd',
				root,
			])
		);
		expect(result).toBe(0);
		const installDir = path.join(root, 'src/shared/subsystems/events');
		expect(fs.existsSync(path.join(installDir, 'event-bus.memory-backend.ts'))).toBe(true);
		expect(fs.existsSync(path.join(installDir, 'event-bus.drizzle-backend.ts'))).toBe(false);
		// EVT-8: copyRuntime skips `domain-events.schema.ts` so the Hygen
		// template (which gates the tenancy column on `events.multi_tenant`)
		// is the sole emitter. It uses `force: true` regardless of backend —
		// switching to the drizzle backend later must not require a
		// follow-up scaffold step.
		expect(fs.existsSync(path.join(installDir, 'domain-events.schema.ts'))).toBe(true);
	});

	test('second install is idempotent without --force', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--force', '--cwd', root])
		);
		// Second run
		const { result, out } = await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--json', '--cwd', root])
		);
		expect(result).toBe(0);
		const parsed = JSON.parse(out);
		expect(parsed.status).toBe('already-installed');
	});
});

describe('subsystem — detection', () => {
	test('detectInstalledSubsystems finds events after install', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		await capture(() =>
			cli.run(['subsystem', 'install', 'events', '--force', '--cwd', root])
		);
		const ctx = await loadContext({ cwd: root, skipDetection: true });
		const installed = await detectInstalledSubsystems(ctx);
		expect(installed.map((i) => i.name)).toContain('events');
	});
});

describe('subsystem — remove stub', () => {
	test('exits 1 with a not-implemented message', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();
		const { result, out } = await capture(() =>
			cli.run(['subsystem', 'remove', 'events', '--cwd', root])
		);
		expect(result).toBe(1);
		expect(out.toLowerCase()).toContain('not yet implemented');
	});
});

describe('runtime-copier unit', () => {
	test('dry-run populates planned[] without writing', async () => {
		const target = fs.mkdtempSync(path.join(os.tmpdir(), 'copier-'));
		tempDirs.push(target);
		const result = await copyRuntime({
			sourceDir: path.join(RUNTIME_ROOT, 'subsystems', 'events'),
			targetDir: path.join(target, 'events'),
			resolveDeps: false,
			dryRun: true,
		});
		expect(result.planned.length).toBeGreaterThan(0);
		expect(result.written).toHaveLength(0);
		expect(fs.existsSync(path.join(target, 'events'))).toBe(false);
	});

	test('non-dry-run writes files and reports unchanged on second run', async () => {
		const target = fs.mkdtempSync(path.join(os.tmpdir(), 'copier2-'));
		tempDirs.push(target);
		const r1 = await copyRuntime({
			sourceDir: path.join(RUNTIME_ROOT, 'subsystems', 'cache'),
			targetDir: path.join(target, 'cache'),
			resolveDeps: false,
		});
		expect(r1.written.length).toBeGreaterThan(0);
		const r2 = await copyRuntime({
			sourceDir: path.join(RUNTIME_ROOT, 'subsystems', 'cache'),
			targetDir: path.join(target, 'cache'),
			resolveDeps: false,
		});
		expect(r2.unchanged.length).toBe(r1.written.length);
		expect(r2.written.length).toBe(0);
	});
});
