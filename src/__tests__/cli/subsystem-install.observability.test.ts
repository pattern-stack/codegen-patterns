/**
 * OBS-7: integration test for `codegen subsystem install observability`.
 *
 * Covers the combiner-subsystem scaffold path (ADR-025):
 *   - `--dry-run` lists planned template targets without writing.
 *   - Against a tmp project with a minimal `app.module.ts`, install
 *     appends the `observability:` config block and leaves `app.module.ts`
 *     byte-identical: the generated `SUBSYSTEM_MODULES` composes the module,
 *     so there is no register-it-yourself TODO (#668).
 *   - Idempotent re-install is a no-op (the config block's `skip_if` holds).
 *   - `--force-config` strips + re-injects the yaml block.
 *   - `printInfo` says observability is composed through `SUBSYSTEM_MODULES`
 *     (#663) — no hand registration.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Cli } from 'clipanion';

import subsystemNoun, { appModuleWiringHint } from '../../cli/commands/subsystem.js';
import { setJsonMode } from '../../cli/ui/json.js';

const APP_MODULE =
	"import { Module } from '@nestjs/common';\n@Module({ imports: [] })\nexport class AppModule {}\n";

function mkTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-'));
	// Minimal config + a stub app.module.ts — the install must leave it alone.
	fs.writeFileSync(
		path.join(dir, 'codegen.config.yaml'),
		// ADR-037: this suite exercises the vendored install path (runtime copy +
		// config block). Opt into `vendored` — the default is now `package`, which
		// skips the runtime-dependent scaffolds.
		'runtime: vendored\npaths:\n  backend_src: src\n',
	);
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'src/app.module.ts'), APP_MODULE);
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
	test('plans only the config block — not app.module.ts — and writes nothing', async () => {
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
		expect(parsed.scaffold.planned).toEqual([path.join(root, 'codegen.config.yaml')]);

		// Config block must NOT have been injected during dry-run.
		const cfg = fs.readFileSync(path.join(root, 'codegen.config.yaml'), 'utf-8');
		expect(cfg).not.toContain('observability:');
		expect(fs.readFileSync(path.join(root, 'src/app.module.ts'), 'utf-8')).toBe(APP_MODULE);
	});
});

describe('subsystem install observability — real', () => {
	test('appends the observability block to codegen.config.yaml; app.module.ts untouched (#668)', async () => {
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

		// No register-it-yourself TODO: SUBSYSTEM_MODULES composes the module.
		const app = fs.readFileSync(path.join(root, 'src/app.module.ts'), 'utf-8');
		expect(app).toBe(APP_MODULE);
		expect(app).not.toContain('ObservabilityModule');
		expect(app).not.toContain('TODO');

		// Config block appended.
		const cfg = fs.readFileSync(path.join(root, 'codegen.config.yaml'), 'utf-8');
		expect(cfg).toContain('observability:');
		expect(cfg).toContain('reporters:');
		expect(cfg).toContain('bridgeMetrics:');
		expect(cfg).toContain('enabled: false');
		expect(cfg).toContain('intervalMs: 60000');
		expect(cfg).toContain('windowHours: 24');

		// Composed by the barrel (last, after the siblings it reads) — #663.
		expect(out).toContain(appModuleWiringHint('observability', 'combiner'));
		expect(out).not.toContain('Register `ObservabilityModule');
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

	test('--force re-install does NOT re-inject the config block, and never touches app.module.ts', async () => {
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

		expect(fs.readFileSync(path.join(root, 'src/app.module.ts'), 'utf-8')).toBe(APP_MODULE);

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
