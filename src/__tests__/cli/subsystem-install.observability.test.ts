/**
 * OBS-7: integration test for `codegen subsystem install observability`.
 *
 * Covers the combiner-subsystem scaffold path (ADR-025):
 *   - `--dry-run` lists planned template targets without writing.
 *   - Against a tmp project with a minimal `app.module.ts`, install
 *     appends the TODO comment block (main-hook.ejs.t) and the
 *     `observability:` config block.
 *   - Idempotent re-install is a no-op (both `skip_if` gates hold).
 *   - `--force-config` strips + re-injects the yaml block.
 *   - `printInfo` emits the combiner-specific hint (no `backend` arg).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Cli } from 'clipanion';

import subsystemNoun from '../../cli/commands/subsystem.js';
import { setJsonMode } from '../../cli/ui/json.js';

function mkTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-'));
	// Minimal config + a stub app.module.ts so the main-hook target exists.
	fs.writeFileSync(
		path.join(dir, 'codegen.config.yaml'),
		// ADR-037: this suite exercises the vendored install path (app.module.ts
		// TODO + comment-block injection). Opt into `vendored` — the default is
		// now `package`, which skips the runtime-dependent scaffolds.
		'runtime: vendored\npaths:\n  subsystems: src/shared/subsystems\n  backend_src: src\n',
	);
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'src/app.module.ts'),
		"import { Module } from '@nestjs/common';\n@Module({ imports: [] })\nexport class AppModule {}\n",
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

describe('subsystem install observability — dry-run', () => {
	test('reports planned files (config block + app.module.ts hook) without writing', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();

		const { result, out } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'observability',
				'--dry-run',
				'--force',
				'--json',
				'--cwd',
				root,
			]),
		);
		expect(result).toBe(0);
		const parsed = JSON.parse(out);
		expect(parsed.subsystem).toBe('observability');
		expect(parsed.dryRun).toBe(true);
		expect(parsed.files.planned.length).toBeGreaterThan(0);
		expect(parsed.scaffold.planned).toEqual(
			expect.arrayContaining([
				path.join(root, 'codegen.config.yaml'),
				path.join(root, 'src/app.module.ts'),
			]),
		);

		// Config block must NOT have been injected during dry-run.
		const cfg = fs.readFileSync(path.join(root, 'codegen.config.yaml'), 'utf-8');
		expect(cfg).not.toContain('observability:');
		// app.module.ts must not contain the TODO comment yet.
		const app = fs.readFileSync(path.join(root, 'src/app.module.ts'), 'utf-8');
		expect(app).not.toContain('TODO: Register ObservabilityModule');
	});
});

describe('subsystem install observability — real', () => {
	test('appends comment block to app.module.ts + observability block to codegen.config.yaml', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();

		const { result, out } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'observability',
				'--force',
				'--cwd',
				root,
			]),
		);
		expect(result).toBe(0);

		// Runtime files were copied.
		const installDir = path.join(root, 'src/shared/subsystems/observability');
		expect(fs.existsSync(installDir)).toBe(true);
		expect(
			fs.existsSync(path.join(installDir, 'observability.protocol.ts')),
		).toBe(true);
		expect(
			fs.existsSync(path.join(installDir, 'observability.module.ts')),
		).toBe(true);

		// Comment block appended to app.module.ts.
		const app = fs.readFileSync(path.join(root, 'src/app.module.ts'), 'utf-8');
		expect(app).toContain('TODO: Register ObservabilityModule');
		expect(app).toContain('ObservabilityModule.forRoot()');
		expect(app).toContain('AFTER Events/Jobs/Bridge/Integration');

		// Config block appended.
		const cfg = fs.readFileSync(path.join(root, 'codegen.config.yaml'), 'utf-8');
		expect(cfg).toContain('observability:');
		expect(cfg).toContain('reporters:');
		expect(cfg).toContain('bridgeMetrics:');
		expect(cfg).toContain('enabled: false');
		expect(cfg).toContain('intervalMs: 60000');
		expect(cfg).toContain('windowHours: 24');

		// Combiner hint (not the default forRoot({ backend }) hint).
		expect(out).toContain(
			'Register `ObservabilityModule.forRoot()` AFTER Events/Jobs/Bridge/Integration',
		);
	});

	test('re-run without flags is idempotent — already-installed short-circuit', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();

		await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'observability',
				'--force',
				'--cwd',
				root,
			]),
		);

		const appBefore = fs.readFileSync(
			path.join(root, 'src/app.module.ts'),
			'utf-8',
		);
		const cfgBefore = fs.readFileSync(
			path.join(root, 'codegen.config.yaml'),
			'utf-8',
		);

		const { result, out } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'observability',
				'--json',
				'--cwd',
				root,
			]),
		);
		expect(result).toBe(0);
		const parsed = JSON.parse(out);
		expect(parsed.status).toBe('already-installed');

		// Files unchanged.
		expect(
			fs.readFileSync(path.join(root, 'src/app.module.ts'), 'utf-8'),
		).toBe(appBefore);
		expect(
			fs.readFileSync(path.join(root, 'codegen.config.yaml'), 'utf-8'),
		).toBe(cfgBefore);
	});

	test('--force re-install does NOT re-inject duplicate comment or config block', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();

		await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'observability',
				'--force',
				'--cwd',
				root,
			]),
		);

		await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'observability',
				'--force',
				'--cwd',
				root,
			]),
		);

		// Comment block appears exactly once (skip_if: "ObservabilityModule").
		const app = fs.readFileSync(path.join(root, 'src/app.module.ts'), 'utf-8');
		const todoMatches = app.match(/TODO: Register ObservabilityModule/g) ?? [];
		expect(todoMatches).toHaveLength(1);

		// observability: block appears exactly once (skip_if: "observability:").
		const cfg = fs.readFileSync(path.join(root, 'codegen.config.yaml'), 'utf-8');
		const blockMatches = cfg.match(/^observability:$/gm) ?? [];
		expect(blockMatches).toHaveLength(1);
	});

	test('--force-config re-injects the yaml block back to defaults', async () => {
		const root = mkTempProject();
		tempDirs.push(root);
		const cli = buildCli();

		await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'observability',
				'--force',
				'--cwd',
				root,
			]),
		);

		// Tamper with the block — append a sentinel that should NOT survive
		// a --force-config re-injection (strip-then-inject overwrites).
		const configPath = path.join(root, 'codegen.config.yaml');
		const original = fs.readFileSync(configPath, 'utf-8');
		fs.writeFileSync(
			configPath,
			original + '\n      # USER-SENTINEL: should NOT survive --force-config\n',
			'utf-8',
		);

		const { result, out } = await capture(() =>
			cli.run([
				'subsystem',
				'install',
				'observability',
				'--force',
				'--force-config',
				'--cwd',
				root,
			]),
		);
		expect(result).toBe(0);

		const after = fs.readFileSync(configPath, 'utf-8');
		expect(after).not.toContain('USER-SENTINEL');
		expect(after).toContain('observability:');
		expect(after).toContain('bridgeMetrics:');
		expect(out).toContain('overwriting existing');
	});
});
